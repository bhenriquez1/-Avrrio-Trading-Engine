import assert from "node:assert/strict";
import { test } from "node:test";
import { explainSymbol, explainSymbolText } from "../src/ai/explainWhy.js";

const goodComponents = {
  trend: 80,
  volume: 80,
  news: 90,
  momentum: 80,
  risk: 80,
  structure: 80,
};

const weakComponents = {
  trend: 20,
  volume: 30,
  news: 90,
  momentum: 10,
  risk: 50,
  structure: 25,
};

test("a strong, tradable, news-clear setup with no blockers qualifies", () => {
  const e = explainSymbol({
    symbol: "NQ",
    tradable: true,
    score: 85,
    minScore: 75,
    components: goodComponents,
    direction: "bullish",
    newsBlocked: false,
    newsReason: "",
    rewardRisk: 3,
    minRewardRisk: 2,
    duplicateOpen: false,
  });
  assert.equal(e.qualifies, true);
  assert.deepEqual(e.blockers, []);
  assert.equal(e.side, "long");
});

test("a low score is reported as a specific blocker", () => {
  const e = explainSymbol({
    symbol: "NQ",
    tradable: true,
    score: 50,
    minScore: 75,
    components: weakComponents,
    direction: "bullish",
    newsBlocked: false,
    newsReason: "",
    rewardRisk: 3,
    minRewardRisk: 2,
    duplicateOpen: false,
  });
  assert.equal(e.qualifies, false);
  assert.ok(e.blockers.some((b) => b.includes("Avrrio Score 50")));
});

test("a watchlist-only (non-tradable) symbol is blocked for that reason", () => {
  const e = explainSymbol({
    symbol: "AAPL",
    tradable: false,
    score: 85,
    minScore: 75,
    components: goodComponents,
    direction: "bullish",
    newsBlocked: false,
    newsReason: "",
    rewardRisk: null,
    minRewardRisk: 2,
    duplicateOpen: false,
  });
  assert.equal(e.qualifies, false);
  assert.ok(e.blockers.some((b) => b.includes("Watchlist-only")));
});

test("a reversal/range direction has no side and is blocked for lacking direction", () => {
  const e = explainSymbol({
    symbol: "NQ",
    tradable: true,
    score: 85,
    minScore: 75,
    components: goodComponents,
    direction: "reversal",
    newsBlocked: false,
    newsReason: "",
    rewardRisk: null,
    minRewardRisk: 2,
    duplicateOpen: false,
  });
  assert.equal(e.side, null);
  assert.ok(e.blockers.some((b) => b.includes("No clear directional trend")));
});

test("news blackout and weak reward/risk both surface as distinct blockers", () => {
  const e = explainSymbol({
    symbol: "NQ",
    tradable: true,
    score: 85,
    minScore: 75,
    components: goodComponents,
    direction: "bullish",
    newsBlocked: true,
    newsReason: "CPI release in 10 minutes",
    rewardRisk: 1,
    minRewardRisk: 2,
    duplicateOpen: false,
  });
  assert.ok(e.blockers.some((b) => b.includes("CPI release")));
  assert.ok(e.blockers.some((b) => b.includes("Reward/risk 1.00:1")));
});

test("a duplicate open position is reported as a blocker", () => {
  const e = explainSymbol({
    symbol: "NQ",
    tradable: true,
    score: 85,
    minScore: 75,
    components: goodComponents,
    direction: "bullish",
    newsBlocked: false,
    newsReason: "",
    rewardRisk: 3,
    minRewardRisk: 2,
    duplicateOpen: true,
  });
  assert.ok(e.blockers.some((b) => b.includes("duplicate")));
});

test("componentNotes cover every weighted component plus structure when present", () => {
  const e = explainSymbol({
    symbol: "NQ",
    tradable: true,
    score: 85,
    minScore: 75,
    components: goodComponents,
    direction: "bullish",
    newsBlocked: false,
    newsReason: "",
    rewardRisk: 3,
    minRewardRisk: 2,
    duplicateOpen: false,
  });
  const labels = e.componentNotes.map((n) => n.label);
  assert.deepEqual(labels, [
    "Trend",
    "Momentum",
    "Volume",
    "Risk",
    "News",
    "Structure",
  ]);
});

test("explainSymbolText renders the score, components, and blockers", () => {
  const e = explainSymbol({
    symbol: "NQ",
    tradable: true,
    score: 50,
    minScore: 75,
    components: weakComponents,
    direction: "bullish",
    newsBlocked: false,
    newsReason: "",
    rewardRisk: 1,
    minRewardRisk: 2,
    duplicateOpen: false,
  });
  const text = explainSymbolText(e);
  assert.match(text, /NQ/);
  assert.match(text, /Avrrio Score: 50\/100/);
  assert.match(text, /Trend 20\/100/);
  assert.match(text, /Blocking this setup right now/);
});

test("explainSymbolText announces a fully-qualifying setup", () => {
  const e = explainSymbol({
    symbol: "NQ",
    tradable: true,
    score: 85,
    minScore: 75,
    components: goodComponents,
    direction: "bullish",
    newsBlocked: false,
    newsReason: "",
    rewardRisk: 3,
    minRewardRisk: 2,
    duplicateOpen: false,
  });
  assert.match(explainSymbolText(e), /clears every filter/);
});
