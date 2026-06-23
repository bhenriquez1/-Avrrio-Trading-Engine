import assert from "node:assert/strict";
import { test } from "node:test";
import { reportTitle, localHour } from "../src/engine.js";

test("reportTitle maps local hour to the right time-of-day label", () => {
  // Morning 04:00–11:59
  assert.match(reportTitle(4), /MORNING/);
  assert.match(reportTitle(8), /MORNING/);   // the 8:26am case that mislabelled "MIDDAY"
  assert.match(reportTitle(11), /MORNING/);
  // Midday 12:00–16:59
  assert.match(reportTitle(12), /MIDDAY/);
  assert.match(reportTitle(16), /MIDDAY/);
  // Evening 17:00–20:59
  assert.match(reportTitle(17), /EVENING/);
  assert.match(reportTitle(20), /EVENING/);
  // Night 21:00–03:59
  assert.match(reportTitle(21), /NIGHT/);
  assert.match(reportTitle(0), /NIGHT/);
  assert.match(reportTitle(3), /NIGHT/);
});

test("localHour respects a timezone and falls back safely", () => {
  // A real IANA zone returns 0-23.
  const h = localHour("America/New_York");
  assert.ok(Number.isInteger(h) && h >= 0 && h < 24);
  // Empty / invalid -> server local hour, never throws.
  assert.ok(Number.isInteger(localHour("")));
  assert.ok(Number.isInteger(localHour("Not/AZone")));
});
