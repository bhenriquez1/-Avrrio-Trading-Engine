import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { AvrrioEngine } from "../src/engine.js";
import { AuditLog } from "../src/audit/auditLog.js";
import { RecommendationStore } from "../src/execution/recommendations.js";
import { RuntimeSettings } from "../src/settings/runtimeSettings.js";

async function tempEngine() {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-cons-"));
  const config = loadConfig();
  const settings = new RuntimeSettings(config, join(dir, "settings.json"));
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const recommendations = new RecommendationStore(join(dir, "recs.json"));
  const engine = new AvrrioEngine(config);
  const i = engine as unknown as { settings: RuntimeSettings; audit: AuditLog; recommendations: RecommendationStore };
  i.settings = settings; i.audit = audit; i.recommendations = recommendations;
  return { engine, recommendations };
}

function recInput(consensusRec: "long" | "short" | "no-trade", agreement: number) {
  return {
    setupName: null, symbol: "MNQ", side: "long" as const, size: 1,
    entry: 20000, stopLoss: 19980, target: 20060,
    riskAmount: 40, rewardRiskRatio: 3, riskApproved: true, violations: [],
    avrrioScore: 90,
    grade: null,
    consensus: { recommendation: consensusRec, confidence: 0.9, agreement, available: 2, opinions: [] },
    news: { blocked: false, reason: "clear" }, autoEligible: false,
    expiresAt: null, approvalMode: null,
  };
}

test("approve is refused (override required) when consensus does not support the trade", async () => {
  const { engine, recommendations } = await tempEngine();
  const rec = await recommendations.add(recInput("no-trade", 0));
  assert.equal(engine.approvalOverrideInfo(rec.id).overrideRequired, true);
  await assert.rejects(() => engine.approve(rec.id, "operator", "immediate"), /OVERRIDE_REQUIRED/);
  // Not executed — still pending/actionable.
  assert.notEqual(recommendations.get(rec.id)?.status, "executed");
});

test("approve proceeds with explicit override against consensus (paper fill)", async () => {
  const { engine, recommendations } = await tempEngine();
  const rec = await recommendations.add(recInput("no-trade", 0));
  const r = await engine.approve(rec.id, "operator", "immediate", true);
  assert.equal(r.result?.paper, true);
  assert.equal(recommendations.get(rec.id)?.status, "executed");
});

test("approve proceeds normally (no override) when consensus supports the trade", async () => {
  const { engine, recommendations } = await tempEngine();
  const rec = await recommendations.add(recInput("long", 2));
  assert.equal(engine.approvalOverrideInfo(rec.id).overrideRequired, false);
  const r = await engine.approve(rec.id, "operator", "immediate");
  assert.equal(r.result?.paper, true);
  assert.equal(recommendations.get(rec.id)?.status, "executed");
});
