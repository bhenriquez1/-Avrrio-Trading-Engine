import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { RuntimeSettings } from "../src/settings/runtimeSettings.js";
import { AvrrioEngine } from "../src/engine.js";
import { AuditLog } from "../src/audit/auditLog.js";
import { RecommendationStore } from "../src/execution/recommendations.js";

test("safety validations persist and reload across instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-val-"));
  const path = join(dir, "settings.json");
  const config = loadConfig();
  const a = new RuntimeSettings(config, path);
  assert.deepEqual(a.getValidations(), {
    telegramTestPassed: false,
    emergencyStopTested: false,
    paperApprovalTestPassed: false,
  });
  await a.markValidation("telegramTestPassed");
  await a.markValidation("emergencyStopTested");

  const b = new RuntimeSettings(config, path);
  await b.load();
  assert.equal(b.getValidations().telegramTestPassed, true);
  assert.equal(b.getValidations().emergencyStopTested, true);
  assert.equal(b.getValidations().paperApprovalTestPassed, false);

  await b.resetValidations();
  const c = new RuntimeSettings(config, path);
  await c.load();
  assert.deepEqual(c.getValidations(), {
    telegramTestPassed: false,
    emergencyStopTested: false,
    paperApprovalTestPassed: false,
  });
});

/**
 * Engine with its persisted settings redirected to a temp dir, returned so tests
 * can set validations directly (no kill-switch / audit file side effects).
 */
async function tempEngine(overrides: { maxPositionSize?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-eng-"));
  const config = loadConfig();
  config.safety.dailyMaxLoss = 1000; // make the two risk-limit checks pass
  config.safety.maxPositionSize = overrides.maxPositionSize ?? 2;
  const settings = new RuntimeSettings(config, join(dir, "settings.json"));
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const recommendations = new RecommendationStore(join(dir, "recs.json"));
  const engine = new AvrrioEngine(config);
  const internals = engine as unknown as {
    settings: RuntimeSettings;
    audit: AuditLog;
    recommendations: RecommendationStore;
  };
  internals.settings = settings;
  internals.audit = audit;
  internals.recommendations = recommendations;
  return { engine, settings, audit, recommendations };
}

test("readiness report aggregates checklist, scores, and stays NOT READY (offline)", async () => {
  const { engine } = await tempEngine();
  const r = await engine.readinessReport(true);
  assert.equal(r.ready, false); // offline/demo auth is not "connected"
  assert.equal(r.liveTradingEnabled, false);
  assert.equal(r.total, 8);
  assert.equal(r.riskLimits.dailyLoss, true);
  assert.equal(r.riskLimits.positionSize, true);
  assert.ok(r.scorePct >= 0 && r.scorePct <= 100);
  assert.ok(r.blockers.length > 0);
  const text = engine.readinessReportText(r);
  assert.match(text, /AVRRIO LIVE-TRADING READINESS/);
  assert.match(text, /Score: \d\/8/);
  assert.match(text, /Overall: NOT READY/);
});

test("completed validations raise the readiness score", async () => {
  const { engine, settings } = await tempEngine();
  const before = await engine.readinessReport(true);
  await settings.markValidation("emergencyStopTested");
  const after = await engine.readinessReport(true);
  assert.equal(after.emergencyStop, true);
  assert.equal(after.passed, before.passed + 1);
});

test("readiness report never reports live trading enabled in this phase", async () => {
  const { engine } = await tempEngine();
  const r = await engine.readinessReport(true);
  assert.equal(r.liveTradingEnabled, false);
  assert.equal(engine.isLiveTradingEnabled(), false);
});

test("approval blocked by position-size lockout returns a block message (no execution)", async () => {
  const { engine, recommendations } = await tempEngine({ maxPositionSize: 1 });
  const rec = await recommendations.add({
    setupName: null,
    symbol: "NQ",
    side: "long",
    size: 5, // exceeds maxPositionSize 1 -> locked out
    entry: 20000,
    stopLoss: 19960,
    target: 20080,
    riskAmount: 800,
    rewardRiskRatio: 2,
    riskApproved: true,
    violations: [],
    avrrioScore: 90,
    consensus: { recommendation: "long", confidence: 0.9, agreement: 2, available: 2, opinions: [] },
    news: { blocked: false, reason: "clear" },
    autoEligible: false,
    expiresAt: null,
    approvalMode: null,
  });
  const msg = await engine.approvalAction("approve", rec.ref);
  assert.match(msg, /blocked by risk limits/i);
  // The trade must NOT have executed.
  assert.notEqual(recommendations.get(rec.id)?.status, "executed");
});
