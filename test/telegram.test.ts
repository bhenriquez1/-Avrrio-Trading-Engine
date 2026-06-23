import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { TelegramService, formatAlert } from "../src/telegram/telegramService.js";
import type { Recommendation } from "../src/execution/recommendations.js";

function rec(): Recommendation {
  return {
    id: "x",
    ref: "T-2481",
    createdAt: "",
    setupName: null,
    symbol: "NQ",
    side: "long",
    size: 1,
    entry: 22150,
    stopLoss: 22120,
    target: 22240,
    riskAmount: 600,
    rewardRiskRatio: 3,
    riskApproved: true,
    violations: [],
    avrrioScore: 95,
    consensus: { recommendation: "long", confidence: 0.92, agreement: 2, available: 2, opinions: [] },
    news: { blocked: false, reason: "clear" },
    autoEligible: false,
    status: "pending",
    approvalToken: "tok",
    expiresAt: null,
    approvalMode: null,
  };
}

test("formatAlert includes all required fields", () => {
  const text = formatAlert(rec());
  assert.match(text, /AVRRIO ALERT/);
  assert.match(text, /Trade ID: T-2481/);
  assert.match(text, /NQ futures/);
  assert.match(text, /LONG/);
  assert.match(text, /Entry: 22150/);
  assert.match(text, /Stop: 22120/);
  assert.match(text, /Target: 22240/);
  assert.match(text, /Risk\/Reward: 3\.0/);
  assert.match(text, /Confidence: 92%/);
  assert.match(text, /Avrrio Score: 95/);
});

test("telegram enabled only when token + chat id + flag set", () => {
  const config = loadConfig();
  config.notifications.telegram = { enabled: true, botToken: "", chatId: "1" };
  assert.equal(new TelegramService(config).enabled, false);
  config.notifications.telegram = { enabled: true, botToken: "t", chatId: "1" };
  assert.equal(new TelegramService(config).enabled, true);
  config.notifications.telegram = { enabled: false, botToken: "t", chatId: "1" };
  assert.equal(new TelegramService(config).enabled, false);
});

test("missing() names exactly which TELEGRAM_* settings are unset", () => {
  const config = loadConfig();
  // Only the enable flag is off (common gotcha): token + chat id are set.
  config.notifications.telegram = { enabled: false, botToken: "t", chatId: "1" };
  assert.deepEqual(new TelegramService(config).missing(), ["TELEGRAM_ENABLED=true"]);
  // Enabled but chat id missing.
  config.notifications.telegram = { enabled: true, botToken: "t", chatId: "" };
  assert.deepEqual(new TelegramService(config).missing(), ["TELEGRAM_CHAT_ID"]);
  // Fully configured.
  config.notifications.telegram = { enabled: true, botToken: "t", chatId: "1" };
  assert.deepEqual(new TelegramService(config).missing(), []);
});

test("sendTest reports the precise missing settings without exposing values", async () => {
  const config = loadConfig();
  config.notifications.telegram = { enabled: false, botToken: "supersecrettoken", chatId: "1" };
  const r = await new TelegramService(config).sendTest();
  assert.equal(r.ok, false);
  assert.match(r.info, /TELEGRAM_ENABLED=true/);
  assert.deepEqual(r.missing, ["TELEGRAM_ENABLED=true"]);
  // The raw token value must never appear in the message.
  assert.doesNotMatch(r.info, /supersecrettoken/);
});

test("presence() masks the token and never leaks values", () => {
  const config = loadConfig();
  config.notifications.telegram = { enabled: true, botToken: "123456789:AAHsupersecrettoken_abcdefghij", chatId: "12345" };
  const p = new TelegramService(config).presence();
  assert.equal(p.TELEGRAM_ENABLED, "true");
  assert.equal(p.TELEGRAM_CHAT_ID, "set");
  const token = p.TELEGRAM_BOT_TOKEN ?? "";
  assert.match(token, /^set \(/);
  assert.match(token, /format OK/);
  assert.doesNotMatch(token, /supersecrettoken/);
});

test("presence() flags a malformed (colon-less) bot token", () => {
  const config = loadConfig();
  config.notifications.telegram = { enabled: true, botToken: "AAAH5Habugxulk-s4MwjEcADrYG94oV6awUY", chatId: "12345" };
  const token = new TelegramService(config).presence().TELEGRAM_BOT_TOKEN ?? "";
  assert.match(token, /INVALID format/);
});

test("sendTest rejects a malformed bot token without leaking it", async () => {
  const config = loadConfig();
  // Colon-less token (Brian's case): the numeric <bot_id>: prefix is missing.
  config.notifications.telegram = { enabled: true, botToken: "AAAH5Habugxulk-s4MwjEcADrYG94oV6awUY", chatId: "12345" };
  const r = await new TelegramService(config).sendTest();
  assert.equal(r.ok, false);
  assert.match(r.info, /Invalid bot token format/);
  assert.doesNotMatch(r.info, /AAAH5Habugxulk/);
});

test("parseCallback extracts a button press; unauthorized chat is rejected", async () => {
  const config = loadConfig();
  config.notifications.telegram = { enabled: true, botToken: "t", chatId: "999" };
  const svc = new TelegramService(config);
  const cb = svc.parseCallback({
    callback_query: { id: "cq1", data: "a|T-2481", message: { message_id: 5, chat: { id: 123 } } },
  });
  assert.ok(cb);
  assert.equal(cb?.data, "a|T-2481");
  assert.equal(cb?.chatId, "123");
  // Different chat than configured (999) -> actor must NOT be called.
  let called = false;
  const result = await svc.handleCallback(cb!, async () => {
    called = true;
    return "should not run";
  });
  assert.equal(called, false);
  assert.equal(result, "unauthorized");
});

test("parseCallback returns null for non-callback updates", () => {
  const config = loadConfig();
  const svc = new TelegramService(config);
  assert.equal(svc.parseCallback({ message: { chat: { id: 1 } } }), null);
});
