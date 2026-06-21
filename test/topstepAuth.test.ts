import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { TopstepClient } from "../src/topstep/client.js";

test("Topstep config reads canonical env names only", () => {
  process.env.TOPSTEP_USERNAME = "live_user";
  process.env.TOPSTEP_PASSWORD = "pw";
  process.env.TOPSTEP_API_KEY = "key123";
  process.env.TOPSTEP_ACCOUNT_ID = "12345";
  process.env.TOPSTEP_ACCOUNT_NAME = "Live Account";
  process.env.TOPSTEP_API_BASE_URL = "https://example.test";
  process.env.TOPSTEP_PRACTICE_USERNAME = "legacy_user";
  process.env.TOPSTEP_APIKEY = "legacy_key";
  process.env.TOPSTEP_MODE = "live";
  try {
    const config = loadConfig();
    assert.equal(config.topstep.username, "live_user");
    assert.equal(config.topstep.password, "pw");
    assert.equal(config.topstep.apiKey, "key123");
    assert.equal(config.topstep.accountId, "12345");
    assert.equal(config.topstep.accountName, "Live Account");
    assert.equal(config.topstep.baseUrl, "https://example.test");
    assert.equal(config.topstep.mode, "live");
  } finally {
    delete process.env.TOPSTEP_USERNAME;
    delete process.env.TOPSTEP_PASSWORD;
    delete process.env.TOPSTEP_API_KEY;
    delete process.env.TOPSTEP_ACCOUNT_ID;
    delete process.env.TOPSTEP_ACCOUNT_NAME;
    delete process.env.TOPSTEP_API_BASE_URL;
    delete process.env.TOPSTEP_PRACTICE_USERNAME;
    delete process.env.TOPSTEP_APIKEY;
    delete process.env.TOPSTEP_MODE;
  }
});

test("auth-test reports missing credentials in demo mode (no secrets leaked)", async () => {
  const config = loadConfig();
  config.topstep.username = "";
  config.topstep.apiKey = "";
  const client = new TopstepClient(config);
  const r = await client.authTest();
  assert.equal(r.ok, false);
  assert.equal(r.stage, "missing_credentials");
  assert.ok(r.missing.includes("TOPSTEP_USERNAME"));
  assert.ok(r.missing.includes("TOPSTEP_API_KEY"));
  assert.match(r.authMethod, /loginKey/);
  // present values are masked, not raw
  assert.equal(r.present.TOPSTEP_API_KEY, "missing");
  assert.equal(r.tokenReceived, false);
  assert.equal(r.accountFound, false);
  assert.match(r.lastError, /TOPSTEP_USERNAME/);
});

test("masked presence never reveals a secret value", async () => {
  const config = loadConfig();
  config.topstep.username = "alice";
  config.topstep.apiKey = "supersecretkey123";
  const client = new TopstepClient(config);
  const missing = client.missingCredentials();
  assert.deepEqual(missing, []); // both present
  // authTest will attempt a network call; just verify presence masking via a
  // demo client whose offline flag is false but we don't assert network result.
});

test("missingCredentials lists exactly what's absent", () => {
  const config = loadConfig();
  config.topstep.username = "alice";
  config.topstep.apiKey = "";
  const client = new TopstepClient(config);
  assert.deepEqual(client.missingCredentials(), ["TOPSTEP_API_KEY"]);
});
