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
import { SYMBOLS } from "../src/symbols/registry.js";

async function tempEngine() {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-rank-"));
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

test("engine.rankMarkets ranks every symbol in the universe, numbered and sorted by score", async () => {
  const { engine } = await tempEngine();
  const ranks = await engine.rankMarkets();
  assert.equal(ranks.length, SYMBOLS.length);
  assert.equal(ranks[0]?.rank, 1);
  for (let k = 1; k < ranks.length; k++) {
    assert.ok((ranks[k - 1]?.score ?? 0) >= (ranks[k]?.score ?? 0));
    assert.equal(ranks[k]?.rank, k + 1);
  }
  assert.ok(ranks.every((r) => typeof r.qualifies === "boolean"));
});

test("/rank via Telegram returns the full numbered breakdown", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("999", "/rank");
  assert.match(r, /RANKED MARKETS/);
  assert.match(r, /1\./);
});
