import assert from "node:assert/strict";
import { test } from "node:test";
import { Auth } from "../src/auth/auth.js";
import { loadConfig } from "../src/config.js";

function configWithPassword(password: string) {
  const config = loadConfig();
  config.dashboard.password = password;
  return config;
}

test("rejects a wrong password and accepts the right one", () => {
  const auth = new Auth(configWithPassword("s3cret"));
  assert.equal(auth.login("wrong"), null);
  const token = auth.login("s3cret");
  assert.ok(token);
  assert.equal(auth.isValid(token ?? undefined), true);
  assert.equal(auth.isValid("not-a-token"), false);
  assert.equal(auth.isValid(undefined), false);
});

test("session token survives a restart (new Auth instance, same password)", () => {
  // Simulates a Render redeploy: the browser keeps its token, the server process
  // is brand new with an empty in-memory token set.
  const token = new Auth(configWithPassword("s3cret")).login("s3cret");
  assert.ok(token);
  const afterRestart = new Auth(configWithPassword("s3cret"));
  assert.equal(afterRestart.isValid(token ?? undefined), true);
});

test("a token minted under a different password does not validate", () => {
  const oldToken = new Auth(configWithPassword("old-pass")).login("old-pass");
  const rotated = new Auth(configWithPassword("new-pass"));
  assert.equal(rotated.isValid(oldToken ?? undefined), false);
});

test("open mode (no password) allows everything", () => {
  const auth = new Auth(configWithPassword(""));
  assert.equal(auth.required, false);
  assert.equal(auth.isValid(undefined), true);
  assert.ok(auth.login(""));
});
