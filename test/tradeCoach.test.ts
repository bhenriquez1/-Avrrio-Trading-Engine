import assert from "node:assert/strict";
import { test } from "node:test";
import { coachReview, type CoachInput } from "../src/ai/tradeCoach.js";

function base(over: Partial<CoachInput> = {}): CoachInput {
  return {
    ref: "T-1042",
    symbol: "NQ",
    side: "long",
    entry: 20000,
    stopLoss: 19980,
    target: 20060,
    rr: 3,
    score: 90,
    consensus: { recommendation: "long", confidence: 0.8, agreement: 2, available: 3 },
    news: { blocked: false, reason: "" },
    overrodeConsensus: false,
    thresholds: { minScore: 85, minRR: 2 },
    structure: { trend: "up", recentHigh: 20100, recentLow: 19900, sma: 19995 },
    last: 20000,
    outcome: null,
    ...over,
  };
}

test("a disciplined trade earns grade A with no critiques", () => {
  const r = coachReview(base());
  assert.equal(r.grade, "A");
  assert.equal(r.critiques.length, 0);
  assert.ok(r.wentWell.length >= 1);
  assert.match(r.summary, /TRADE COACH/);
});

test("poor R:R is flagged", () => {
  const r = coachReview(base({ rr: 0.9 }));
  assert.ok(r.critiques.some((c) => /Reward\/risk was only 0.9/.test(c)));
  assert.notEqual(r.grade, "A");
});

test("trading against an AI WAIT is flagged", () => {
  const r = coachReview(
    base({ consensus: { recommendation: "no-trade", confidence: 0.6, agreement: 2, available: 3 } }),
  );
  assert.ok(r.critiques.some((c) => /WAIT \(no-trade\)/.test(c)));
});

test("consensus override is called out", () => {
  const r = coachReview(base({ overrodeConsensus: true }));
  assert.ok(r.critiques.some((c) => /against the AI consensus/.test(c)));
});

test("late/extended long entry near the high is flagged", () => {
  const r = coachReview(
    base({
      last: 20099, // ~0.5% above sma 19995 and within 0.15% of recentHigh 20100
      structure: { trend: "up", recentHigh: 20100, recentLow: 19900, sma: 19995 },
    }),
  );
  assert.ok(r.critiques.some((c) => /late/i.test(c)));
  assert.ok(r.critiques.some((c) => /session high/i.test(c)));
});

test("a losing closed trade adds the result to critiques", () => {
  const r = coachReview(base({ outcome: { realizedPnl: -120, paper: true } }));
  assert.ok(r.critiques.some((c) => /-\$120/.test(c)));
});

test("a winning closed trade is reinforced", () => {
  const r = coachReview(base({ outcome: { realizedPnl: 250, paper: true } }));
  assert.ok(r.wentWell.some((w) => /\+\$250/.test(w)));
});

test("a sloppy trade (multiple breaks) earns a low grade", () => {
  const r = coachReview(
    base({
      rr: 0.8,
      score: 60,
      consensus: { recommendation: "no-trade", confidence: 0.5, agreement: 1, available: 3 },
      overrodeConsensus: true,
    }),
  );
  assert.equal(r.grade, "D");
  assert.ok(r.critiques.length >= 3);
});
