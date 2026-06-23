import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { AvrrioEngine, type LiveTradingChecklist } from "../src/engine.js";
import { AuditLog } from "../src/audit/auditLog.js";
import { RuntimeSettings } from "../src/settings/runtimeSettings.js";

async function tempEngine() {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-live-"));
  const config = loadConfig();
  const settings = new RuntimeSettings(config, join(dir, "settings.json"));
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const engine = new AvrrioEngine(config);
  const i = engine as unknown as { settings: RuntimeSettings; audit: AuditLog };
  i.settings = settings; i.audit = audit;
  return { engine };
}

test("setLiveTrading(true) is blocked while the checklist is not ready", async () => {
  const { engine } = await tempEngine();
  // Offline sandbox -> auth checks fail -> not ready.
  await assert.rejects(() => engine.setLiveTrading(true, "operator"), /locked until all checks pass/i);
  assert.equal(engine.isLiveTradingEnabled(), false);
});

test("setLiveTrading(true) enables, audits live_trading_enabled, and alerts when ready", async () => {
  const { engine } = await tempEngine();
  // Force a READY checklist (auth/account would be green on the real deploy).
  const ready: LiveTradingChecklist = {
    projectxAuth: true, tokenReceived: true, accountFound: true,
    telegramTestPassed: true, emergencyStopTested: true,
    maxDailyLossConfigured: true, maxPositionSizeConfigured: true,
    paperApprovalTestPassed: true, ready: true, blockers: [],
  };
  const e = engine as unknown as {
    liveTradingChecklist: () => Promise<LiveTradingChecklist>;
    broadcast: (text: string, type?: string) => Promise<void>;
  };
  e.liveTradingChecklist = async () => ready;
  const sent: string[] = [];
  e.broadcast = async (text: string) => { sent.push(text); };

  await engine.setLiveTrading(true, "operator");
  assert.equal(engine.isLiveTradingEnabled(), true);
  assert.ok(sent.some((t) => /LIVE TRADING ENABLED/.test(t)));

  const audit = await engine.audit.recent(20);
  assert.ok(audit.some((a) => a.type === "live_trading_enabled"));
});
