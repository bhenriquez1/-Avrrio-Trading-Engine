import assert from "node:assert/strict";
import { test } from "node:test";
import { RiskManager } from "../src/risk/riskManager.js";
import type { AccountSummary, TradeIdea } from "../src/types.js";

const account: AccountSummary = {
  id: "T",
  name: "Test",
  balance: 50_000,
  dayPnl: 0,
  rules: { maxDailyLoss: 1_000, maxDrawdown: 2_000, maxPositionSize: 5 },
};

const baseIdea: TradeIdea = {
  symbol: "MNQ", // point value 2
  side: "long",
  size: 1,
  entry: 20_000,
  stopLoss: 19_980, // 20 pts * 2 = $40 risk
  target: 20_060, // 60 pts -> R:R 3.0
};

test("approves a clean idea with good reward/risk", () => {
  const rm = new RiskManager();
  const r = rm.assess(baseIdea, account);
  assert.equal(r.approved, true);
  assert.equal(r.riskAmount, 40);
  assert.equal(r.rewardRiskRatio, 3);
});

test("blocks a stop on the wrong side", () => {
  const rm = new RiskManager();
  const r = rm.assess({ ...baseIdea, stopLoss: 20_050 }, account);
  assert.equal(r.approved, false);
  assert.ok(r.violations.some((v) => v.rule === "stop-side"));
});

test("blocks poor reward/risk", () => {
  const rm = new RiskManager();
  const r = rm.assess({ ...baseIdea, target: 20_010 }, account);
  assert.equal(r.approved, false);
  assert.ok(r.violations.some((v) => v.rule === "reward-risk"));
});

test("blocks oversize beyond account max", () => {
  const rm = new RiskManager();
  const r = rm.assess({ ...baseIdea, size: 10 }, account);
  assert.equal(r.approved, false);
  assert.ok(r.violations.some((v) => v.rule === "max-position-size"));
});

test("blocks a trade exceeding the remaining daily-loss budget", () => {
  const rm = new RiskManager();
  // ES point value 50; 30 pts * 5 * 50 = $7,500 risk > $1,000 budget.
  const r = rm.assess(
    {
      symbol: "ES",
      side: "long",
      size: 5,
      entry: 5_300,
      stopLoss: 5_270,
      target: 5_400,
    },
    account,
  );
  assert.equal(r.approved, false);
  assert.ok(r.violations.some((v) => v.rule === "daily-loss-budget"));
});
