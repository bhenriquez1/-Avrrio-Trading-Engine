import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTradeContext,
  computeWhatIf,
  parseScenario,
} from "../src/ai/tradeChat.js";
import type { Recommendation } from "../src/execution/recommendations.js";

function rec(over: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "id-1",
    ref: "T-1042",
    createdAt: new Date().toISOString(),
    setupName: "pullback",
    symbol: "NQ",
    side: "long",
    size: 2,
    entry: 20000,
    stopLoss: 19980, // 20 pts risk
    target: 20060, // 60 pts reward -> R:R 3.0
    riskAmount: 200, // $200 for 2 contracts over 20 pts -> $5/pt/contract
    rewardRiskRatio: 3,
    riskApproved: true,
    violations: [],
    avrrioScore: 88,
    consensus: {
      recommendation: "long",
      confidence: 0.5,
      agreement: 2,
      available: 3,
      opinions: [],
    },
    news: { blocked: false, reason: "" },
    autoEligible: false,
    status: "pending",
    approvalToken: "tok",
    expiresAt: null,
    approvalMode: null,
    ...over,
  };
}

test("parseScenario understands stop/target/entry/size/winrate", () => {
  assert.deepEqual(parseScenario("move my stop to 19990"), { stopLoss: 19990 });
  assert.deepEqual(parseScenario("target 20100"), { target: 20100 });
  assert.deepEqual(parseScenario("entry at 20005"), { entry: 20005 });
  assert.equal(parseScenario("only one contract").size, 1);
  assert.equal(parseScenario("size 3").size, 3);
  assert.equal(parseScenario("2 contracts").size, 2);
  assert.equal(parseScenario("what if my win rate is 40%").winRate, 0.4);
});

test("computeWhatIf recomputes R:R when the stop moves", () => {
  const r = computeWhatIf(rec(), "move my stop to 19990"); // risk 20 -> 10 pts
  assert.equal(r.base.rr, 3);
  assert.equal(r.adjusted.rr, 6); // 60 pts reward / 10 pts risk
  assert.ok(r.changes.some((c) => /stop/.test(c)));
  // Dollar risk halves (10 pts vs 20 pts) at $5/pt/contract * 2 = $100.
  assert.equal(r.adjusted.riskAmount, 100);
  assert.equal(r.adjusted.rewardAmount, 600);
});

test("computeWhatIf scales dollars with size, not R:R", () => {
  const r = computeWhatIf(rec(), "only one contract");
  assert.equal(r.adjusted.size, 1);
  assert.equal(r.adjusted.rr, 3); // ratio unchanged by size
  assert.equal(r.adjusted.riskAmount, 100); // half of $200
  assert.equal(r.adjusted.rewardAmount, 300);
});

test("expectancy uses the asked win rate", () => {
  const r = computeWhatIf(rec(), "what if my win rate is 40%");
  assert.ok(r.expectancy);
  // 0.4*600 - 0.6*200 = 240 - 120 = 120
  assert.equal(r.expectancy!.winRate, 0.4);
  assert.equal(r.expectancy!.value, 120);
});

test("expectancy falls back to consensus confidence when not asked", () => {
  const r = computeWhatIf(rec(), "move my stop to 19990");
  // confidence 0.5: 0.5*600 - 0.5*100 = 250
  assert.ok(r.expectancy);
  assert.equal(r.expectancy!.winRate, 0.5);
  assert.equal(r.expectancy!.value, 250);
});

test("unrecognised scenario leaves the trade unchanged", () => {
  const r = computeWhatIf(rec(), "what if the moon is full");
  assert.equal(r.changes.length, 0);
  assert.deepEqual(r.adjusted, r.base);
  assert.match(r.summary, /no recognised change/i);
});

test("buildTradeContext is secret-free and trade-scoped", () => {
  const ctx = buildTradeContext(rec({ approvalToken: "SECRET-TOKEN-XYZ" }));
  assert.match(ctx, /T-1042/);
  assert.match(ctx, /NQ/);
  assert.match(ctx, /ADVISORY ONLY/);
  assert.doesNotMatch(ctx, /SECRET-TOKEN-XYZ/); // never leak the approval token
});

test("zero-risk trade yields null dollar figures, never divides by zero", () => {
  const r = computeWhatIf(rec({ entry: 100, stopLoss: 100, target: 110, riskAmount: 0 }), "target 120");
  assert.equal(r.base.riskAmount, null);
  assert.equal(r.adjusted.riskAmount, null);
  assert.equal(r.expectancy, null);
});
