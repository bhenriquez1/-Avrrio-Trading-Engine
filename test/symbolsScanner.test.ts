import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSymbol,
  isTradable,
  listByClass,
  tradableSymbols,
} from "../src/symbols/registry.js";
import { avrrioScore, SCORE_WEIGHTS } from "../src/scanner/scanner.js";

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
