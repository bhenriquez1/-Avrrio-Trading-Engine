import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestLevels } from "../src/scanner/scanner.js";
import type { MarketSnapshot } from "../src/market/marketData.js";

function snapshot(last: number): MarketSnapshot {
  const bars = Array.from({ length: 10 }, (_, i) => ({
    symbol: "NQ",
    timestamp: new Date().toISOString(),
    open: last,
    high: last + 5,
    low: last - 5,
    close: last,
    volume: 1000 + i,
  }));
  return {
    symbol: "NQ",
    quote: { symbol: "NQ", bid: last - 0.25, ask: last + 0.25, last, timestamp: "" },
    bars,
    structure: { trend: "up", recentHigh: last + 5, recentLow: last - 5, sma: last },
  };
}

test("suggestLevels yields ~3:1 reward/risk for a long", () => {
  const lv = suggestLevels(snapshot(20000), "long");
  assert.ok(lv.stopLoss < lv.entry, "stop below entry for long");
  assert.ok(lv.target > lv.entry, "target above entry for long");
  const rr =
    Math.abs(lv.target - lv.entry) / Math.abs(lv.entry - lv.stopLoss);
  assert.ok(Math.abs(rr - 3) < 1e-6, `R/R should be 3, got ${rr}`);
});

test("suggestLevels yields ~3:1 reward/risk for a short", () => {
  const lv = suggestLevels(snapshot(5300), "short");
  assert.ok(lv.stopLoss > lv.entry, "stop above entry for short");
  assert.ok(lv.target < lv.entry, "target below entry for short");
  const rr =
    Math.abs(lv.target - lv.entry) / Math.abs(lv.entry - lv.stopLoss);
  assert.ok(Math.abs(rr - 3) < 1e-6, `R/R should be 3, got ${rr}`);
});
