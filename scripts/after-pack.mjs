import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const plistBuddy = "/usr/libexec/PlistBuddy";

async function run(plistPath, command, allowMissing = false) {
  try {
    await execute(plistBuddy, ["-c", command, plistPath]);
  } catch (error) {
    if (!allowMissing) throw error;
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const plistPath = join(context.appOutDir, appName, "Contents", "Info.plist");

  for (const key of [
    "NSAudioCaptureUsageDescription",
    "NSBluetoothAlwaysUsageDescription",
    "NSBluetoothPeripheralUsageDescription",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
  ]) {
    await run(plistPath, `Delete :${key}`, true);
  }

  await run(plistPath, "Delete :NSAppTransportSecurity", true);
  await run(plistPath, "Add :NSAppTransportSecurity dict");
  await run(plistPath, "Add :NSAppTransportSecurity:NSAllowsArbitraryLoads bool false");
  await run(plistPath, "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool false");
}
