import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDebate, type DebateInput } from "../src/ai/debate.js";

function base(over: Partial<DebateInput> = {}): DebateInput {
  return {
    symbol: "NQ",
    side: "long",
    score: 90,
    rr: 3,
    consensus: { recommendation: "long", confidence: 0.8, agreement: 2, available: 3 },
    news: { blocked: false, reason: "" },
    components: { trend: 85, volume: 70, momentum: 75, news: 90, risk: 80 },
    structure: { trend: "up", recentHigh: 20100, recentLow: 19900, sma: 19990 },
    last: 20000,
    thresholds: { minScore: 85, minRR: 2 },
    ...over,
  };
}

test("strong bullish setup -> LONG verdict with bull-heavy case", () => {
  const r = buildDebate(base());
  assert.equal(r.verdict, "long");
  assert.ok(r.bullCase.length > r.bearCase.length);
  assert.ok(r.confidence > 0.5);
  assert.match(r.summary, /Bull case:/);
  assert.match(r.summary, /Bear case:/);
  assert.match(r.summary, /Final verdict/);
});

test("news blackout forces WAIT regardless of score", () => {
  const r = buildDebate(base({ news: { blocked: true, reason: "CPI in 5 min" } }));
  assert.equal(r.verdict, "wait");
  assert.ok(r.bearCase.some((b) => /News risk/.test(b)));
});

test("poor reward/risk forces WAIT (mirrors the scanner gate)", () => {
  const r = buildDebate(base({ rr: 0.9 }));
  assert.equal(r.verdict, "wait");
  assert.ok(r.bearCase.some((b) => /Reward\/risk is poor/.test(b)));
});

test("consensus no-trade -> WAIT even with a decent score", () => {
  const r = buildDebate(
    base({ consensus: { recommendation: "no-trade", confidence: 0.6, agreement: 2, available: 3 } }),
  );
  assert.equal(r.verdict, "wait");
});

test("extended-above-mean + near-high reads as bear evidence", () => {
  const r = buildDebate(
    base({
      last: 20099, // ~0.5% above sma 19990 and within 0.15% of recentHigh 20100
      structure: { trend: "up", recentHigh: 20100, recentLow: 19900, sma: 19990 },
    }),
  );
  assert.ok(r.bearCase.some((b) => /extended/i.test(b)));
  assert.ok(r.bearCase.some((b) => /resistance/i.test(b)));
});

test("degrades gracefully with almost no data", () => {
  const r = buildDebate({ symbol: "CL" });
  assert.equal(r.symbol, "CL");
  assert.equal(r.verdict, "wait");
  assert.ok(r.bullCase.length >= 1 && r.bearCase.length >= 1);
  assert.ok(r.confidence >= 0 && r.confidence <= 1);
});

test("short consensus -> SHORT verdict", () => {
  const r = buildDebate(
    base({
      side: "short",
      consensus: { recommendation: "short", confidence: 0.75, agreement: 2, available: 3 },
      structure: { trend: "down", recentHigh: 20100, recentLow: 19900, sma: 20010 },
      last: 20000,
    }),
  );
  assert.equal(r.verdict, "short");
});
