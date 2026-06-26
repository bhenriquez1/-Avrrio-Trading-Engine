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
import { TradeMemory } from "../src/memory/tradeMemory.js";

async function tempEngine() {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-why-"));
  const config = loadConfig();
  config.notifications.telegram = {
    enabled: false,
    botToken: "",
    chatId: "999",
  };
  const settings = new RuntimeSettings(config, join(dir, "settings.json"));
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const killSwitch = new KillSwitch(config, audit, join(dir, "kill.json"));
  const engine = new AvrrioEngine(config);
  const i = engine as unknown as {
    settings: RuntimeSettings;
    audit: AuditLog;
    killSwitch: KillSwitch;
    memory: TradeMemory;
  };
  i.settings = settings;
  i.audit = audit;
  i.killSwitch = killSwitch;
  i.memory = new TradeMemory(join(dir, "memory.json"));
  return { engine };
}

test("engine.explainSymbol returns a full breakdown for an arbitrary symbol", async () => {
  const { engine } = await tempEngine();
  const e = await engine.explainSymbol("nq"); // lowercase input is normalized
  assert.equal(e.symbol, "NQ");
  assert.ok(typeof e.score === "number");
  assert.ok(e.componentNotes.length >= 5);
  assert.ok(["bullish", "bearish", "reversal"].includes(e.direction));
  assert.equal(typeof e.qualifies, "boolean");
});

test("/why <symbol> via Telegram returns the per-symbol breakdown, not the scan-level summary", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("999", "/why NQ");
  assert.match(r, /WHY — NQ/);
  assert.match(r, /Avrrio Score:/);
});

test("/why with no argument still falls back to the latest-scan explanation", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("999", "/why");
  assert.match(r, /WHY NO TRADE|A\+ setup/);
});
