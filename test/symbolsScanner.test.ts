import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSymbol,
  isTradable,
  listByClass,
  tradableSymbols,
} from "../src/symbols/registry.js";
import { avrrioScore, scoreSnapshot, SCORE_WEIGHTS } from "../src/scanner/scanner.js";
import type { Bar, Quote } from "../src/types.js";
import type { MarketSnapshot } from "../src/market/marketData.js";

function bar(close: number, volume = 100): Bar {
  return { symbol: "NQ", timestamp: "", open: close, high: close + 1, low: close - 1, close, volume };
}

function snapshotWithCloses(closes: number[], trend: "up" | "down" | "sideways"): MarketSnapshot {
  const bars = closes.map((c) => bar(c));
  const last = closes[closes.length - 1] ?? 0;
  const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
  const quote: Quote = { symbol: "NQ", bid: last, ask: last, last, timestamp: "" };
  return {
    symbol: "NQ",
    quote,
    bars,
    structure: { trend, recentHigh: Math.max(...closes), recentLow: Math.min(...closes), sma },
  };
}

test("futures are tradable, stocks and crypto are watchlist-only", () => {
  assert.equal(isTradable("NQ"), true);
  assert.equal(isTradable("MGC"), true);
  assert.equal(isTradable("AAPL"), false);
  assert.equal(isTradable("BTCUSD"), false);
});

test("unknown / manually entered symbols are never tradable", () => {
  assert.equal(isTradable("FOO"), false);
  assert.equal(findSymbol("FOO"), undefined);
});

test("symbol lookup is case-insensitive", () => {
  assert.equal(findSymbol("nq")?.symbol, "NQ");
});

test("registry has the expected classes", () => {
  assert.equal(listByClass("stocks").length, 8);
  assert.equal(listByClass("crypto").length, 3);
  assert.ok(tradableSymbols().every((s) => s.assetClass === "futures"));
});

test("score weights sum to 1", () => {
  const sum = Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test("avrrioScore is a weighted 0..100 blend", () => {
  assert.equal(
    avrrioScore({ trend: 100, volume: 100, news: 100, momentum: 100, risk: 100 }),
    100,
  );
  assert.equal(
    avrrioScore({ trend: 0, volume: 0, news: 0, momentum: 0, risk: 0 }),
    0,
  );
  // News weight is 20%: only news maxed → 18 (rounded from 20*0.9? here 100*0.2).
  assert.equal(
    avrrioScore({ trend: 0, volume: 0, news: 100, momentum: 0, risk: 0 }),
    20,
  );
});

test("structure scores a clean monotonic uptrend confirmed above its average higher than a choppy one", () => {
  const clean = snapshotWithCloses([100, 101, 102, 103, 104, 105, 106, 107], "up");
  const choppy = snapshotWithCloses([100, 102, 99, 103, 98, 104, 97, 105], "up");
  const { components: cleanComponents } = scoreSnapshot(clean, false);
  const { components: choppyComponents } = scoreSnapshot(choppy, false);
  assert.ok(
    (cleanComponents.structure ?? 0) > (choppyComponents.structure ?? 0),
    `expected clean trend structure score to beat choppy one (${cleanComponents.structure} vs ${choppyComponents.structure})`,
  );
});

test("structure is neutral (50) when there are fewer than 2 bars", () => {
  const snapshot = snapshotWithCloses([100], "up");
  const { components } = scoreSnapshot(snapshot, false);
  assert.equal(components.structure, 50);
});
