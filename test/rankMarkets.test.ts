import assert from "node:assert/strict";
import { test } from "node:test";
import { rankMarket, rankMarketsText } from "../src/ai/rankMarkets.js";

const baseInput = {
  symbol: "NQ",
  name: "E-mini Nasdaq 100",
  tradable: true,
  score: 85,
  minScore: 75,
  direction: "bullish" as const,
  newsBlocked: false,
  rewardRisk: 3,
  minRewardRisk: 2,
  duplicateOpen: false,
};

test("a fully-qualifying symbol is marked qualifies with no blocking reason", () => {
  const r = rankMarket(baseInput, 1);
  assert.equal(r.qualifies, true);
  assert.equal(r.side, "long");
  assert.match(r.reason, /qualifies/);
});

test("a watchlist-only symbol is ranked but never qualifies", () => {
  const r = rankMarket({ ...baseInput, tradable: false }, 1);
  assert.equal(r.qualifies, false);
  assert.match(r.reason, /Watchlist-only/);
});

test("a reversal/range direction has no side and does not qualify", () => {
  const r = rankMarket({ ...baseInput, direction: "reversal" }, 1);
  assert.equal(r.side, null);
  assert.equal(r.qualifies, false);
  assert.match(r.reason, /directional/);
});

test("a low score does not qualify and reports the threshold", () => {
  const r = rankMarket({ ...baseInput, score: 50 }, 1);
  assert.equal(r.qualifies, false);
  assert.match(r.reason, /Avrrio Score 50/);
});

test("news blackout does not qualify", () => {
  const r = rankMarket({ ...baseInput, newsBlocked: true }, 1);
  assert.equal(r.qualifies, false);
  assert.match(r.reason, /News risk/);
});

test("weak reward/risk does not qualify", () => {
  const r = rankMarket({ ...baseInput, rewardRisk: 1 }, 1);
  assert.equal(r.qualifies, false);
  assert.match(r.reason, /Reward\/risk 1\.00:1/);
});

test("a duplicate open position does not qualify", () => {
  const r = rankMarket({ ...baseInput, duplicateOpen: true }, 1);
  assert.equal(r.qualifies, false);
  assert.match(r.reason, /Duplicate open position/);
});

test("rank number is preserved on the result", () => {
  const r = rankMarket(baseInput, 7);
  assert.equal(r.rank, 7);
});

test("rankMarketsText renders a numbered list with score and reason", () => {
  const ranks = [
    rankMarket(baseInput, 1),
    rankMarket({ ...baseInput, symbol: "ES", score: 50 }, 2),
  ];
  const text = rankMarketsText(ranks);
  assert.match(text, /RANKED MARKETS/);
  assert.match(text, /1\. ✅ NQ — 85\/100/);
  assert.match(text, /2\. — ES — 50\/100/);
});
