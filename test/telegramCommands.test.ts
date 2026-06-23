import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { AvrrioEngine } from "../src/engine.js";
import { AuditLog } from "../src/audit/auditLog.js";
import { KillSwitch } from "../src/safety/killSwitch.js";
import { RuntimeSettings } from "../src/settings/runtimeSettings.js";
import { TelegramService } from "../src/telegram/telegramService.js";

async function tempEngine() {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-tg-"));
  const config = loadConfig();
  // Authorized chat = 999; telegram disabled so sendText() no-ops (no network).
  config.notifications.telegram = { enabled: false, botToken: "", chatId: "999" };
  const settings = new RuntimeSettings(config, join(dir, "settings.json"));
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const killSwitch = new KillSwitch(config, audit, join(dir, "kill.json"));
  const engine = new AvrrioEngine(config);
  const i = engine as unknown as { settings: RuntimeSettings; audit: AuditLog; killSwitch: KillSwitch };
  i.settings = settings; i.audit = audit; i.killSwitch = killSwitch;
  return { engine };
}

test("parseMessage + isAuthorized", () => {
  const config = loadConfig();
  config.notifications.telegram = { enabled: true, botToken: "123:abc", chatId: "999" };
  const svc = new TelegramService(config);
  assert.deepEqual(svc.parseMessage({ message: { chat: { id: 999 }, text: "/status" } }), { chatId: "999", text: "/status" });
  assert.equal(svc.parseMessage({ message: { chat: { id: 1 } } }), null); // no text
  assert.equal(svc.isAuthorized("999"), true);
  assert.equal(svc.isAuthorized("123"), false);
});

test("unauthorized chat is rejected and takes no action", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("123", "/stop");
  assert.equal(r, "unauthorized");
  assert.equal(engine.killSwitch.isEngaged(), false);
});

test("/status returns account + scheduler status", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("999", "/status");
  assert.match(r, /AVRRIO STATUS/);
  assert.match(r, /Kill switch/);
  assert.match(r, /Scheduler/);
});

test("/stop engages emergency stop; /resume needs confirm", async () => {
  const { engine } = await tempEngine();
  const stop = await engine.handleTelegramCommand("999", "/stop");
  assert.match(stop, /ENGAGED/);
  assert.equal(engine.killSwitch.isEngaged(), true);
  // Without confirm, it must NOT clear.
  const noConfirm = await engine.handleTelegramCommand("999", "/resume");
  assert.match(noConfirm, /resume confirm/i);
  assert.equal(engine.killSwitch.isEngaged(), true);
  // With confirm, it clears.
  await engine.handleTelegramCommand("999", "/resume confirm");
  assert.equal(engine.killSwitch.isEngaged(), false);
});

test("/ask is advisory only and never trades (offline stub)", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("999", "/ask should I buy NQ?");
  assert.match(r, /offline|advisory|Claude/i);
});

test("/help lists commands; unknown command shows help", async () => {
  const { engine } = await tempEngine();
  assert.match(await engine.handleTelegramCommand("999", "/help"), /commands/i);
  assert.match(await engine.handleTelegramCommand("999", "/bogus"), /Unknown command/);
});

test("/approve and /reject require a trade id", async () => {
  const { engine } = await tempEngine();
  assert.match(await engine.handleTelegramCommand("999", "/approve"), /Usage: \/approve/);
  assert.match(await engine.handleTelegramCommand("999", "/reject"), /Usage: \/reject/);
});
