import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, legacyEnvWarnings } from "../src/config.js";
import { smsMissing } from "../src/sms/smsClient.js";

test("smsMissing lists exactly the missing Twilio vars", () => {
  const config = loadConfig();
  config.notifications.sms.twilioAccountSid = "";
  config.notifications.sms.twilioAuthToken = "tok";
  config.notifications.sms.fromNumber = "";
  config.notifications.sms.toNumber = "+15551234567";
  assert.deepEqual(smsMissing(config), [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_FROM_NUMBER",
  ]);
});

test("smsMissing is empty when fully configured", () => {
  const config = loadConfig();
  config.notifications.sms.twilioAccountSid = "AC1";
  config.notifications.sms.twilioAuthToken = "tok";
  config.notifications.sms.fromNumber = "+15550000000";
  config.notifications.sms.toNumber = "+15551234567";
  assert.deepEqual(smsMissing(config), []);
});

test("legacyEnvWarnings flags deprecated names and maps to canonical", () => {
  process.env.TOPSTEP_APIKEY = "x";
  process.env.BRIAN_PHONE_NUMBER = "+15551234567";
  try {
    const warns = legacyEnvWarnings();
    assert.ok(warns.some((w) => w.includes("TOPSTEP_APIKEY") && w.includes("TOPSTEP_API_KEY")));
    assert.ok(warns.some((w) => w.includes("BRIAN_PHONE_NUMBER") && w.includes("ALERT_PHONE_NUMBER")));
  } finally {
    delete process.env.TOPSTEP_APIKEY;
    delete process.env.BRIAN_PHONE_NUMBER;
  }
});
