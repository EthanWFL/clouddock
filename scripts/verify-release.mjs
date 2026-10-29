import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FuseV1Options,
  FuseVersion,
  getCurrentFuseWire,
} from "@electron/fuses";
import fuseConstants from "@electron/fuses/dist/constants.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const { FuseState } = fuseConstants;
const REQUIRED_URL_SCHEMES = ["clouddock", "opsdock"];

function printUsage() {
  console.log(`Usage: npm run verify:release -- [--skip-package]

Runs typecheck, unit tests, renderer tests, Electron E2E tests, npm audit,
ARM64 DMG packaging, and release artifact validation.

Options:
  --skip-package  Skip DMG packaging and artifact validation.
  --help          Show this help.`);
}

function parseArguments(arguments_) {
  const options = { skipPackage: false };
  for (const argument of arguments_) {
    if (argument === "--skip-package") options.skipPackage = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function runCommand(label, command, arguments_, { capture = false, env = {} } = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, arguments_, {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${label} terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    if (capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${label} failed with exit code ${result.status}`);
  }

  return capture ? result.stdout.trim() : "";
}

function runNpm(label, arguments_) {
  if (process.env.npm_execpath) {
    return runCommand(label, process.execPath, [process.env.npm_execpath, ...arguments_]);
  }
  return runCommand(label, "npm", arguments_);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expandArtifactName(template, values) {
  const expanded = template.replace(/\$\{(productName|version|arch|ext)\}/g, (_, key) => values[key]);
  assert(!expanded.includes("${"), `Unsupported DMG artifact name template: ${template}`);
  return expanded;
}

function releasePaths() {
  const productName = packageJson.build?.productName ?? packageJson.name;
  const outputDirectory = resolve(
    projectRoot,
    packageJson.build?.directories?.output ?? "dist",
  );
  const artifactTemplate = packageJson.build?.dmg?.artifactName
    ?? "${productName}-${version}-${arch}.${ext}";
  const artifactName = expandArtifactName(artifactTemplate, {
    productName,
    version: packageJson.version,
    arch: "arm64",
    ext: "dmg",
  });
  const appPath = join(outputDirectory, "mac-arm64", `${productName}.app`);

  return {
    productName,
    dmgPath: join(outputDirectory, artifactName),
    appPath,
    executablePath: join(appPath, "Contents", "MacOS", productName),
  };
}

async function assertPath(path, expectedType) {
  await access(path);
  const details = await stat(path);
  const valid = expectedType === "file" ? details.isFile() : details.isDirectory();
  assert(valid, `${relative(projectRoot, path)} is not a ${expectedType}`);
  return details;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyFuses(appPath) {
  console.log("\n==> Electron fuses");
  const wire = await getCurrentFuseWire(appPath);
  assert(wire.version === FuseVersion.V1, `Expected Electron fuse wire v1, got v${wire.version}`);

  const expectations = [
    [FuseV1Options.RunAsNode, "RunAsNode", FuseState.DISABLE],
    [FuseV1Options.EnableCookieEncryption, "EnableCookieEncryption", FuseState.ENABLE],
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable, "EnableNodeOptionsEnvironmentVariable", FuseState.DISABLE],
    [FuseV1Options.EnableNodeCliInspectArguments, "EnableNodeCliInspectArguments", FuseState.DISABLE],
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation, "EnableEmbeddedAsarIntegrityValidation", FuseState.ENABLE],
    [FuseV1Options.OnlyLoadAppFromAsar, "OnlyLoadAppFromAsar", FuseState.ENABLE],
    [FuseV1Options.GrantFileProtocolExtraPrivileges, "GrantFileProtocolExtraPrivileges", FuseState.DISABLE],
  ];

  for (const [option, name, expected] of expectations) {
    const actual = wire[option];
    const expectedLabel = expected === FuseState.ENABLE ? "Enabled" : "Disabled";
    assert(actual === expected, `${name} must be ${expectedLabel}, got fuse state ${actual}`);
    console.log(`  ${name}: ${expectedLabel}`);
  }
}

async function verifyRendererBundle() {
  console.log("\n==> Renderer bundle boundaries");
  const rendererDirectory = join(projectRoot, "out", "renderer");
  const assetsDirectory = join(rendererDirectory, "assets");
  const html = await readFile(join(rendererDirectory, "index.html"), "utf8");
  const mainEntryMatch = html.match(/<script[^>]+src="\.\/(assets\/[^\"]+\.js)"/);
  assert(mainEntryMatch, "Could not identify the Renderer main entry in index.html");

  const jsFiles = (await readdir(assetsDirectory))
    .filter((name) => name.endsWith(".js"))
    .sort();
  assert(jsFiles.length >= 2, `Expected at least two Renderer JS chunks, got ${jsFiles.length}`);

  const mainEntryName = mainEntryMatch[1].slice("assets/".length);
  const sources = await Promise.all(jsFiles.map(async (name) => ({
    name,
    source: await readFile(join(assetsDirectory, name), "utf8"),
  })));
  const mainEntry = sources.find(({ name }) => name === mainEntryName);
  assert(mainEntry, `Renderer main entry is missing: ${mainEntryName}`);
  assert(!mainEntry.source.includes("cmdk-root"), "Renderer main entry must not statically include cmdk");
  assert(
    sources.some(({ name, source }) => name !== mainEntryName && source.includes("cmdk-root")),
    "Expected cmdk in a lazy Renderer chunk",
  );
  assert(
    sources.every(({ source }) => !source.includes("ZodType")),
    "Renderer chunks must not include the Zod runtime",
  );

  console.log(`  Main entry: ${mainEntryName}`);
  console.log(`  JavaScript chunks: ${jsFiles.length}`);
  console.log("  cmdk: lazy chunk only");
  console.log("  Zod runtime: absent");
}

function verifyProtocolDeclarations(appPath) {
  const infoPlistPath = join(appPath, "Contents", "Info.plist");
  const bundleIdentifier = runCommand(
    "App bundle identifier",
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlistPath],
    { capture: true },
  );
  assert(
    bundleIdentifier === packageJson.build?.appId,
    `Expected bundle identifier ${packageJson.build?.appId}, got ${bundleIdentifier}`,
  );

  const urlTypes = JSON.parse(runCommand(
    "App URL schemes",
    "/usr/bin/plutil",
    ["-extract", "CFBundleURLTypes", "json", "-o", "-", infoPlistPath],
    { capture: true },
  ));
  const declaredSchemes = new Set(
    urlTypes.flatMap((type) => type.CFBundleURLSchemes ?? []),
  );
  const configuredSchemes = new Set(packageJson.build?.protocols
    ?.flatMap((protocol) => protocol.schemes ?? [])
    ?? []);
  for (const scheme of REQUIRED_URL_SCHEMES) {
    assert(configuredSchemes.has(scheme), `package.json does not declare URL scheme: ${scheme}`);
    assert(declaredSchemes.has(scheme), `App bundle does not declare URL scheme: ${scheme}`);
  }
  console.log(`  ${bundleIdentifier}: ${REQUIRED_URL_SCHEMES.join(", ")}`);
}

async function verifyArtifacts(packageStartedAt) {
  const { dmgPath, appPath, executablePath } = releasePaths();
  const dmgDetails = await assertPath(dmgPath, "file");
  await assertPath(appPath, "directory");
  await assertPath(executablePath, "file");
  assert(
    dmgDetails.mtimeMs >= packageStartedAt - 2_000,
    `DMG was not regenerated by this run: ${relative(projectRoot, dmgPath)}`,
  );

  runCommand("DMG checksum", "/usr/bin/hdiutil", ["verify", dmgPath]);
  runCommand("Code signature", "/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  verifyProtocolDeclarations(appPath);

  const fileDescription = runCommand("Mach-O file type", "/usr/bin/file", [executablePath], {
    capture: true,
  });
  assert(/Mach-O.*\barm64\b/.test(fileDescription), `Expected an arm64 Mach-O executable, got: ${fileDescription}`);
  console.log(fileDescription);

  const architectures = runCommand("Mach-O architectures", "/usr/bin/lipo", [
    "-archs",
    executablePath,
  ], { capture: true });
  assert(architectures === "arm64", `Expected only arm64, got: ${architectures}`);
  console.log(`  ${architectures}`);

  await verifyFuses(appPath);
  await verifyRendererBundle();
  const digest = await sha256(dmgPath);
  console.log(`\nSHA-256: ${digest}  ${relative(projectRoot, dmgPath)}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.skipPackage) {
    assert(process.platform === "darwin", "ARM64 DMG verification requires macOS");
    assert(process.arch === "arm64", `ARM64 packaging requires an arm64 Node.js process, got ${process.arch}`);
  }

  console.log(`CloudDock ${packageJson.version} release verification`);
  if (process.env.ELECTRON_MIRROR) {
    console.log("Electron mirror: inherited from ELECTRON_MIRROR");
  }

  runNpm("TypeScript typecheck", ["run", "typecheck"]);
  runNpm("Unit tests", ["run", "test:unit"]);
  runNpm("Renderer tests", ["run", "test:renderer"]);
  runNpm("Electron E2E tests", ["run", "test:e2e"]);
  runNpm("Dependency audit", ["audit", "--audit-level=low"]);

  if (options.skipPackage) {
    console.log("\n==> ARM64 DMG package and artifact checks skipped (--skip-package)");
    console.log("\nRelease code checks passed; package was not verified.");
    return;
  }

  const packageStartedAt = Date.now();
  runNpm("ARM64 DMG package", ["run", "package:mac"]);
  await verifyArtifacts(packageStartedAt);
  console.log("\nRelease verification passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nRelease verification failed: ${message}`);
  process.exitCode = 1;
});
