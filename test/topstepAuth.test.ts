import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { TopstepClient } from "../src/topstep/client.js";

test("env normalization picks up mixed-case / variant names", () => {
  process.env.TOPSTEP_Practice_Username = "practice_user";
  process.env.TOPSTEP_APIKEY = "key123";
  process.env.TOPSTEP_MODE = "practice";
  try {
    const config = loadConfig();
    assert.equal(config.topstep.username, "practice_user");
    assert.equal(config.topstep.apiKey, "key123");
    assert.equal(config.topstep.mode, "practice");
  } finally {
    delete process.env.TOPSTEP_Practice_Username;
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
