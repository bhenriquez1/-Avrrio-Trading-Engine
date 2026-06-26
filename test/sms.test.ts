import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSmsCommand, normalizeRef } from "../src/sms/inbound.js";
import { samePhone } from "../src/sms/smsClient.js";
import { formatSignalSms } from "../src/sms/messages.js";
import type { Recommendation } from "../src/execution/recommendations.js";

test("parses approve commands (YES/APPROVE)", () => {
  assert.deepEqual(parseSmsCommand("YES T-1042"), { type: "approve", ref: "T-1042" });
  assert.deepEqual(parseSmsCommand("approve 1042"), { type: "approve", ref: "T-1042" });
});

test("parses reject commands (NO/REJECT)", () => {
  assert.deepEqual(parseSmsCommand("NO T-1042"), { type: "reject", ref: "T-1042" });
  assert.deepEqual(parseSmsCommand("reject t1042"), { type: "reject", ref: "T-1042" });
});

test("parses control commands", () => {
  assert.deepEqual(parseSmsCommand("STOPALL"), { type: "stopall" });
  assert.deepEqual(parseSmsCommand("status"), { type: "status" });
  assert.deepEqual(parseSmsCommand("Pending"), { type: "pending" });
});

test("unknown commands are flagged", () => {
  assert.equal(parseSmsCommand("hello there").type, "unknown");
  assert.equal(parseSmsCommand("YES").type, "unknown"); // missing ref
});

test("normalizeRef handles formats", () => {
  assert.equal(normalizeRef("T-1042"), "T-1042");
  assert.equal(normalizeRef("1042"), "T-1042");
  assert.equal(normalizeRef("t1042"), "T-1042");
});

test("samePhone compares the last 10 digits", () => {
  assert.equal(samePhone("+15551234567", "5551234567"), true);
  assert.equal(samePhone("(555) 123-4567", "+1 555 123 4567"), true);
  assert.equal(samePhone("5551234567", "5559999999"), false);
  assert.equal(samePhone("", "5551234567"), false);
});

test("formatSignalSms includes ref, levels, and reply instructions", () => {
  const rec = {
    ref: "T-1042",
    symbol: "NQ",
    side: "long",
    size: 1,
    entry: 20000,
    stopLoss: 19960,
    target: 20080,
    riskAmount: 800,
    avrrioScore: 91,
    grade: null,
    consensus: { confidence: 0.84 },
  } as Recommendation;
  const text = formatSignalSms(rec);
  assert.match(text, /Trade ID: T-1042/);
  assert.match(text, /R:R = 1:2/);
  assert.match(text, /Avrrio Score: 91\/100/);
  assert.match(text, /YES T-1042/);
  assert.match(text, /NO T-1042/);
  assert.match(text, /STOPALL/);
});
