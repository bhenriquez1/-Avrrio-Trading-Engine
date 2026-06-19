import assert from "node:assert/strict";
import { test } from "node:test";
import { RiskManager, type RiskContext } from "../src/risk/riskManager.js";
import { withinAllowedHours } from "../src/setups/types.js";
import type { AccountSummary, TradeIdea } from "../src/types.js";
import type { SetupDefinition } from "../src/setups/types.js";

const account: AccountSummary = {
  id: "T",
  name: "Test",
  balance: 50_000,
  dayPnl: 0,
  rules: { maxDailyLoss: 1_000, maxDrawdown: 2_000, maxPositionSize: 5 },
};

// MNQ point value 2: 20pt stop * 1 = $40 risk, 60pt target -> R:R 3.
const idea: TradeIdea = {
  symbol: "MNQ",
  side: "long",
  size: 1,
  entry: 20_000,
  stopLoss: 19_980,
  target: 20_060,
};

const safety = { maxPositionSize: 2, maxTradesPerDay: 2, maxRiskPerTrade: 300 };

test("kill switch blocks everything", () => {
  const rm = new RiskManager();
  const ctx: RiskContext = { killSwitchEngaged: true, safety };
  const r = rm.assess(idea, account, ctx);
  assert.equal(r.approved, false);
  assert.ok(r.violations.some((v) => v.rule === "kill-switch"));
});

test("high-impact news blocks unless overridden", () => {
  const rm = new RiskManager();
  const news = { blocked: true, reason: "FOMC in 5 min" };
  assert.equal(rm.assess(idea, account, { news, safety }).approved, false);
  assert.equal(
    rm.assess(idea, account, { news, newsOverride: true, safety }).approved,
    true,
  );
});

test("max trades per day blocks", () => {
  const rm = new RiskManager();
  const r = rm.assess(idea, account, { tradesToday: 2, safety });
  assert.equal(r.approved, false);
  assert.ok(r.violations.some((v) => v.rule === "max-trades-per-day"));
});

test("duplicate open trade blocks", () => {
  const rm = new RiskManager();
  const r = rm.assess(idea, account, { duplicateOpen: true, safety });
  assert.equal(r.approved, false);
  assert.ok(r.violations.some((v) => v.rule === "duplicate-trade"));
});

test("engine max risk per trade blocks", () => {
  const rm = new RiskManager();
  // ES point value 50: 10pt * 1 * 50 = $500 risk > $300 cap.
  const big: TradeIdea = {
    symbol: "ES",
    side: "long",
    size: 1,
    entry: 5_300,
    stopLoss: 5_290,
    target: 5_330,
  };
  const r = rm.assess(big, account, { safety });
  assert.equal(r.approved, false);
  assert.ok(r.violations.some((v) => v.rule === "max-risk-per-trade"));
});

test("outside allowed hours blocks", () => {
  const rm = new RiskManager();
  const r = rm.assess(idea, account, { withinAllowedHours: false, safety });
  assert.equal(r.approved, false);
  assert.ok(r.violations.some((v) => v.rule === "trading-hours"));
});

test("withinAllowedHours respects the window", () => {
  const setup: SetupDefinition = {
    name: "X",
    symbol: "NQ",
    direction: "long",
    entryCondition: "",
    stopLossRule: "",
    takeProfitRule: "",
    maxRisk: 100,
    allowedHours: "09:30-11:00",
    invalidationRules: [],
  };
  assert.equal(withinAllowedHours(setup, new Date("2026-06-19T10:00:00")), true);
  assert.equal(withinAllowedHours(setup, new Date("2026-06-19T14:00:00")), false);
});
