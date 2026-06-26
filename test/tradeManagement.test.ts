import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessPosition,
  managementEmoji,
  managementLabel,
  managementText,
  TIGHTEN_STOP_R,
  TAKE_PARTIAL_R,
} from "../src/ai/tradeManagement.js";

test("long position with no R move yet and trend aligned holds", () => {
  const r = assessPosition({
    side: "long",
    entry: 20000,
    stopLoss: 19960,
    target: 20120,
    last: 20010,
    trend: "up",
  });
  assert.equal(r.action, "hold");
  assert.ok(r.rMultiple < TIGHTEN_STOP_R);
});

test("long position up 1R with trend aligned tightens the stop to breakeven", () => {
  const r = assessPosition({
    side: "long",
    entry: 20000,
    stopLoss: 19960,
    target: 20120,
    last: 20040,
    trend: "up",
  });
  assert.equal(r.action, "tighten_stop");
  assert.equal(r.suggestedStop, 20000);
});

test("long position up 2R with trend aligned takes a partial profit", () => {
  const r = assessPosition({
    side: "long",
    entry: 20000,
    stopLoss: 19960,
    target: 20200,
    last: 20080,
    trend: "up",
  });
  assert.equal(r.action, "take_partial");
  assert.ok(r.rMultiple >= TAKE_PARTIAL_R);
});

test("long position whose trend reverses against it exits, even while still in profit", () => {
  const r = assessPosition({
    side: "long",
    entry: 20000,
    stopLoss: 19960,
    target: 20200,
    last: 20040,
    trend: "down",
  });
  assert.equal(r.action, "exit");
  assert.match(r.reason, /reversed/);
});

test("long position whose trend reverses against it while behind entry still exits", () => {
  const r = assessPosition({
    side: "long",
    entry: 20000,
    stopLoss: 19960,
    target: 20200,
    last: 19990,
    trend: "down",
  });
  assert.equal(r.action, "exit");
  assert.match(r.reason, /loss grows/);
});

test("long position that reaches its target exits", () => {
  const r = assessPosition({
    side: "long",
    entry: 20000,
    stopLoss: 19960,
    target: 20100,
    last: 20105,
    trend: "up",
  });
  assert.equal(r.action, "exit");
  assert.match(r.reason, /target/);
});

test("short position up 1R with trend aligned tightens the stop to breakeven", () => {
  const r = assessPosition({
    side: "short",
    entry: 20000,
    stopLoss: 20040,
    target: 19880,
    last: 19960,
    trend: "down",
  });
  assert.equal(r.action, "tighten_stop");
  assert.equal(r.suggestedStop, 20000);
});

test("short position whose trend reverses against it exits", () => {
  const r = assessPosition({
    side: "short",
    entry: 20000,
    stopLoss: 20040,
    target: 19800,
    last: 19960,
    trend: "up",
  });
  assert.equal(r.action, "exit");
});

test("short position that reaches its target exits", () => {
  const r = assessPosition({
    side: "short",
    entry: 20000,
    stopLoss: 20040,
    target: 19900,
    last: 19890,
    trend: "down",
  });
  assert.equal(r.action, "exit");
  assert.match(r.reason, /target/);
});

test("sideways trend counts as aligned for both long and short", () => {
  const long = assessPosition({
    side: "long",
    entry: 20000,
    stopLoss: 19960,
    target: 20120,
    last: 20005,
    trend: "sideways",
  });
  assert.equal(long.action, "hold");
  const short = assessPosition({
    side: "short",
    entry: 20000,
    stopLoss: 20040,
    target: 19880,
    last: 19995,
    trend: "sideways",
  });
  assert.equal(short.action, "hold");
});

test("managementEmoji and managementLabel cover every action", () => {
  for (const action of [
    "hold",
    "tighten_stop",
    "take_partial",
    "exit",
  ] as const) {
    assert.ok(managementEmoji(action).length > 0);
    assert.ok(managementLabel(action).length > 0);
  }
});

test("managementText renders the ref, symbol, and reason", () => {
  const signal = assessPosition({
    side: "long",
    entry: 20000,
    stopLoss: 19960,
    target: 20120,
    last: 20040,
    trend: "up",
  });
  const text = managementText("T-1042", "MNQ", signal);
  assert.match(text, /T-1042/);
  assert.match(text, /MNQ/);
  assert.match(text, /breakeven/);
});
