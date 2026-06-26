import assert from "node:assert/strict";
import { test } from "node:test";
import { selectOrderType, orderTypeLabel } from "../src/ai/orderSelection.js";

test("a long entry above the current price (breakout) selects a stop order", () => {
  const result = selectOrderType({ side: "long", entry: 20100 }, 20000);
  assert.equal(result.orderType, "stop_market");
  assert.match(result.rationale, /breakout/);
});

test("a long entry below the current price (pullback) selects a limit order", () => {
  const result = selectOrderType({ side: "long", entry: 19900 }, 20000);
  assert.equal(result.orderType, "limit");
  assert.match(result.rationale, /pullback/);
});

test("a short entry below the current price (breakout) selects a stop order", () => {
  const result = selectOrderType({ side: "short", entry: 19900 }, 20000);
  assert.equal(result.orderType, "stop_market");
});

test("a short entry above the current price (pullback) selects a limit order", () => {
  const result = selectOrderType({ side: "short", entry: 20100 }, 20000);
  assert.equal(result.orderType, "limit");
});

test("an entry already at the current price selects a market order", () => {
  const result = selectOrderType({ side: "long", entry: 20005 }, 20000);
  assert.equal(result.orderType, "market");
});

test("never silently defaults to market: missing/invalid price falls back to limit, not market", () => {
  const result = selectOrderType({ side: "long", entry: 20000 }, 0);
  assert.equal(result.orderType, "limit");
});

test("orderTypeLabel renders a readable label for each order type", () => {
  assert.equal(orderTypeLabel("limit"), "Limit");
  assert.equal(orderTypeLabel("stop_market"), "Stop Market");
  assert.equal(orderTypeLabel("market"), "Market");
});
