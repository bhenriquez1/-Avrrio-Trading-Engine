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

// --- DAILY_MAX_LOSS: stricter of broker limit and internal env cap ---------

test("daily loss — broker account limit blocks when budget is exhausted", () => {
  const rm = new RiskManager();
  // Broker maxDailyLoss 1000, already down 990 -> only $10 left; idea risks ~$40.
  const acct = { ...account, dayPnl: -990 };
  const r = rm.assess(idea, acct, { safety });
  assert.equal(r.approved, false);
  const v = r.violations.find((x) => x.rule === "daily-loss-budget");
  assert.ok(v);
  assert.match(v.message, /broker maxDailyLoss/);
});

test("daily loss — DAILY_MAX_LOSS provides a tighter cap than the broker", () => {
  const rm = new RiskManager();
  // Broker limit 1000 with no loss yet, but internal cap $30 < idea risk ~$40.
  const r = rm.assess(idea, account, { safety: { ...safety, maxDailyLoss: 30 } });
  assert.equal(r.approved, false);
  const v = r.violations.find((x) => x.rule === "daily-loss-budget");
  assert.ok(v);
  assert.match(v.message, /DAILY_MAX_LOSS/);
});

test("daily loss — missing DAILY_MAX_LOSS still enforces broker protection", () => {
  const rm = new RiskManager();
  const acct = { ...account, dayPnl: -990 };
  // safety has no maxDailyLoss -> falls back to broker limit, which still blocks.
  assert.equal(rm.assess(idea, acct, { safety }).approved, false);
  // And a comfortably-within-budget trade is still allowed.
  assert.equal(rm.assess(idea, account, { safety }).approved, true);
});

test("daily loss — a looser DAILY_MAX_LOSS never weakens the broker limit", () => {
  const rm = new RiskManager();
  const acct = { ...account, dayPnl: -990 }; // $10 left under broker's $1000
  // Internal cap is larger (5000) -> stricter broker limit still applies.
  const r = rm.assess(idea, acct, { safety: { ...safety, maxDailyLoss: 5000 } });
  assert.equal(r.approved, false);
  assert.ok(r.violations.some((x) => x.rule === "daily-loss-budget"));
});
