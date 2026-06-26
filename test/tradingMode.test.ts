import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../src/audit/auditLog.js";
import { configWarnings, loadConfig } from "../src/config.js";
import { OrderExecutor } from "../src/execution/orderExecutor.js";
import { RecommendationStore } from "../src/execution/recommendations.js";
import { KillSwitch } from "../src/safety/killSwitch.js";
import { RuntimeSettings } from "../src/settings/runtimeSettings.js";
import { TopstepClient } from "../src/topstep/client.js";
import { parseTradingMode } from "../src/types.js";

test("parseTradingMode normalizes input and defaults to telegram_approval", () => {
  assert.equal(parseTradingMode("advisor"), "advisor");
  assert.equal(parseTradingMode("FULL_AUTO"), "full_auto");
  assert.equal(parseTradingMode("full-auto"), "full_auto");
  assert.equal(parseTradingMode("Telegram Approval"), "telegram_approval");
  assert.equal(parseTradingMode("nonsense"), "telegram_approval");
  assert.equal(parseTradingMode(undefined), "telegram_approval");
});

test("default trading mode is telegram_approval", () => {
  const config = loadConfig();
  assert.equal(config.execution.tradingMode, "telegram_approval");
});

test("trading mode persists and reloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-mode-"));
  const path = join(dir, "settings.json");
  const config = loadConfig();
  const a = new RuntimeSettings(config, path);
  assert.equal(a.getTradingMode(), "telegram_approval");
  await a.setTradingMode("advisor");
  const b = new RuntimeSettings(config, path);
  await b.load();
  assert.equal(b.getTradingMode(), "advisor");
});

test("advisor mode blocks order execution on every path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-adv-"));
  const config = loadConfig();
  const settings = new RuntimeSettings(config, join(dir, "settings.json"));
  await settings.setTradingMode("advisor");
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const store = new RecommendationStore(join(dir, "recs.json"));
  const killSwitch = new KillSwitch(config, audit, join(dir, "kill.json"));
  const client = new TopstepClient(config); // offline/demo
  const executor = new OrderExecutor(settings, client, killSwitch, store, audit);

  const rec = await store.add({
    setupName: null,
    symbol: "NQ",
    side: "long",
    size: 1,
    entry: 20000,
    stopLoss: 19960,
    target: 20080,
    riskAmount: 800,
    rewardRiskRatio: 2,
    riskApproved: true,
    violations: [],
    avrrioScore: 90,
    grade: null,
    consensus: { recommendation: "long", confidence: 0.9, agreement: 2, available: 2, opinions: [] },
    news: { blocked: false, reason: "clear" },
    autoEligible: false,
    expiresAt: null,
    approvalMode: null,
  });

  await assert.rejects(() => executor.execute(rec, "operator"), /advisor mode/i);
  // Advisor mode must NOT corrupt the recommendation — it stays actionable
  // (pending) so the operator can still enter it manually in TopstepX.
  assert.equal(store.get(rec.id)?.status, "pending");

  // Switching to telegram_approval lets a paper fill go through.
  await settings.setTradingMode("telegram_approval");
  const rec2 = await store.add({
    setupName: null,
    symbol: "NQ",
    side: "long",
    size: 1,
    entry: 20000,
    stopLoss: 19960,
    target: 20080,
    riskAmount: 800,
    rewardRiskRatio: 2,
    riskApproved: true,
    violations: [],
    avrrioScore: 90,
    grade: null,
    consensus: { recommendation: "long", confidence: 0.9, agreement: 2, available: 2, opinions: [] },
    news: { blocked: false, reason: "clear" },
    autoEligible: false,
    expiresAt: null,
    approvalMode: null,
  });
  const result = await executor.execute(rec2, "operator");
  assert.equal(result.paper, true);
  assert.equal(store.get(rec2.id)?.status, "executed");
});

test("configWarnings reflects the runtime mode override, not just env default", () => {
  const config = loadConfig();
  // Default (telegram_approval) emits neither full-auto nor advisor warning.
  const base = configWarnings(config);
  assert.equal(base.some((w) => w.includes("full_auto")), false);
  // Runtime override to full_auto surfaces the auto-execute safety warning.
  const auto = configWarnings(config, { tradingMode: "full_auto" });
  assert.ok(auto.some((w) => w.includes("full_auto") && w.includes("auto-execute")));
  // Runtime override to advisor surfaces the alerts-only warning.
  const adv = configWarnings(config, { tradingMode: "advisor" });
  assert.ok(adv.some((w) => w.includes("advisor") && w.includes("NOT place")));
});
