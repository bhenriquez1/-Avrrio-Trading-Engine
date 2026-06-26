import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { AvrrioEngine } from "../src/engine.js";
import { AuditLog } from "../src/audit/auditLog.js";
import {
  RecommendationStore,
  type NewRecommendation,
} from "../src/execution/recommendations.js";
import { RuntimeSettings } from "../src/settings/runtimeSettings.js";
import { TelegramService } from "../src/telegram/telegramService.js";
import type { MarketSnapshot } from "../src/market/marketData.js";

async function tempEngine() {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-tm-"));
  const config = loadConfig();
  config.notifications.telegram = { enabled: false, botToken: "", chatId: "" };
  const settings = new RuntimeSettings(config, join(dir, "settings.json"));
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const recommendations = new RecommendationStore(join(dir, "recs.json"));
  const telegram = new TelegramService(config);
  const engine = new AvrrioEngine(config);
  const i = engine as unknown as AvrrioEngine & {
    settings: RuntimeSettings;
    audit: AuditLog;
    recommendations: RecommendationStore;
    telegram: TelegramService;
    snapshot: (symbol: string) => Promise<MarketSnapshot>;
  };
  i.settings = settings;
  i.audit = audit;
  i.recommendations = recommendations;
  i.telegram = telegram;
  return { engine: i, audit, recommendations, dir };
}

function fakeSnapshot(
  last: number,
  trend: "up" | "down" | "sideways",
): MarketSnapshot {
  return {
    symbol: "NQ",
    quote: {
      symbol: "NQ",
      bid: last,
      ask: last,
      last,
      timestamp: new Date().toISOString(),
    },
    bars: [],
    structure: {
      trend,
      recentHigh: last + 50,
      recentLow: last - 50,
      sma: last,
    },
  };
}

const baseRec: NewRecommendation = {
  setupName: null,
  symbol: "NQ",
  side: "long",
  size: 1,
  entry: 20000,
  stopLoss: 19960,
  target: 20200,
  riskAmount: 40,
  rewardRiskRatio: 5,
  riskApproved: true,
  violations: [],
  avrrioScore: 80,
  grade: null,
  orderType: "limit",
  orderTypeRationale: "test fixture",
  consensus: {
    recommendation: "long",
    confidence: 0.8,
    agreement: 3,
    available: 3,
    opinions: [],
  },
  news: { blocked: false, reason: "" },
  autoEligible: false,
  expiresAt: null,
  approvalMode: null,
};

async function executedRec(recommendations: RecommendationStore) {
  const rec = await recommendations.add(baseRec);
  rec.status = "executed";
  await recommendations.update(rec);
  return rec;
}

test("reviewOpenPositions broadcasts a management signal for a newly-executed open position", async () => {
  const { engine, audit, recommendations } = await tempEngine();
  const rec = await executedRec(recommendations);
  engine.snapshot = async () => fakeSnapshot(20040, "up"); // up 1R -> tighten_stop

  await engine.reviewOpenPositions();

  const updated = recommendations.get(rec.id);
  assert.equal(updated?.lastManagementAction, "tighten_stop");
  const entries = await audit.recent(1000);
  assert.ok(
    entries.some(
      (e) =>
        e.type === "trade.management" &&
        e.details.ref === rec.ref &&
        e.details.action === "tighten_stop",
    ),
  );
});

test("reviewOpenPositions does not re-alert when the management action is unchanged", async () => {
  const { engine, audit, recommendations } = await tempEngine();
  const rec = await executedRec(recommendations);
  engine.snapshot = async () => fakeSnapshot(20040, "up");

  await engine.reviewOpenPositions();
  const afterFirst = (await audit.recent(1000)).filter(
    (e) => e.type === "trade.management",
  ).length;

  await engine.reviewOpenPositions(); // same price/trend, same action
  const afterSecond = (await audit.recent(1000)).filter(
    (e) => e.type === "trade.management",
  ).length;

  assert.equal(
    afterSecond,
    afterFirst,
    "should not log a second trade.management entry for an unchanged signal",
  );
});

test("reviewOpenPositions sets managementClosedAt and stops further reviews once an exit is recommended", async () => {
  const { engine, audit, recommendations } = await tempEngine();
  const rec = await executedRec(recommendations);
  engine.snapshot = async () => fakeSnapshot(20040, "down"); // trend reversed -> exit

  await engine.reviewOpenPositions();
  const closed = recommendations.get(rec.id);
  assert.equal(closed?.lastManagementAction, "exit");
  assert.ok(closed?.managementClosedAt);

  // No longer returned as an open position, so a second cycle does nothing.
  assert.equal(recommendations.openPositions().length, 0);
  const before = (await audit.recent(1000)).filter(
    (e) => e.type === "trade.management",
  ).length;
  await engine.reviewOpenPositions();
  const after = (await audit.recent(1000)).filter(
    (e) => e.type === "trade.management",
  ).length;
  assert.equal(after, before);
});

test("closePosition marks a position closed and stops further management alerts", async () => {
  const { engine, recommendations } = await tempEngine();
  const rec = await executedRec(recommendations);

  const closed = await engine.closePosition(rec.ref, "operator");
  assert.ok(closed.managementClosedAt);
  assert.equal(recommendations.openPositions().length, 0);
});
