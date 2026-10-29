import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCloudDockUrl,
  matchPageUrl,
  normalizeRule,
  sanitizeRules,
} from "../rules.js";

test("matches exact hosts and path prefixes", () => {
  const rules = [normalizeRule({ id: "one", host: "console.example.com", pathPrefix: "/projects/" })];
  assert.equal(matchPageUrl("https://console.example.com/projects/42?tab=build", rules).ok, true);
  assert.equal(matchPageUrl("https://console.example.com/other", rules).ok, false);
  assert.equal(matchPageUrl("https://sub.console.example.com/projects/42", rules).ok, false);
});

test("wildcards match subdomains but not the root or lookalikes", () => {
  const rules = [normalizeRule({ id: "one", host: "*.tools.example.com", pathPrefix: "/" })];
  assert.equal(matchPageUrl("https://team.tools.example.com/run", rules).ok, true);
  assert.equal(matchPageUrl("https://tools.example.com/run", rules).ok, false);
  assert.equal(matchPageUrl("https://eviltools.example.com/run", rules).ok, false);
});

test("rejects non-HTTPS pages, ports, and disabled rules", () => {
  const rules = [normalizeRule({ id: "one", host: "console.example.com", pathPrefix: "/", enabled: false })];
  assert.equal(matchPageUrl("http://console.example.com/", rules).ok, false);
  assert.equal(matchPageUrl("https://console.example.com:8443/", rules).ok, false);
  assert.equal(matchPageUrl("https://console.example.com/", rules).ok, false);
});

test("sanitizes invalid, duplicate, and excess stored rules", () => {
  const values = [
    { id: "one", host: "console.example.com", pathPrefix: "/" },
    { id: "one", host: "other.example.com", pathPrefix: "/" },
    { id: "bad", host: "not a domain", pathPrefix: "/" },
  ];
  assert.deepEqual(sanitizeRules(values).map((rule) => rule.id), ["one"]);
});

test("encodes the complete page URL for the CloudDock protocol", () => {
  const source = "https://console.example.com/projects/42?a=1&b=two#logs";
  const deepLink = buildCloudDockUrl(source);
  assert.equal(deepLink, `clouddock://open?url=${encodeURIComponent(source)}`);
});
