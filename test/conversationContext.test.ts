import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractMentionedSymbols,
  mentionsOpenPositions,
} from "../src/ai/conversationContext.js";

const symbols = ["NQ", "MNQ", "ES", "GC"];

test("extracts a known symbol mentioned by name", () => {
  assert.deepEqual(
    extractMentionedSymbols("what about NQ right now?", symbols),
    ["NQ"],
  );
});

test("matches symbols case-insensitively", () => {
  assert.deepEqual(extractMentionedSymbols("how does nq look", symbols), [
    "NQ",
  ]);
});

test("does not match a symbol as a substring of another word", () => {
  assert.deepEqual(
    extractMentionedSymbols("equator and esoteric", symbols),
    [],
  );
});

test("de-duplicates repeated mentions and finds multiple symbols", () => {
  const found = extractMentionedSymbols("NQ vs NQ vs GC today", symbols);
  assert.deepEqual([...found].sort(), ["GC", "NQ"]);
});

test("returns nothing when no known symbol is mentioned", () => {
  assert.deepEqual(
    extractMentionedSymbols("how is the market overall?", symbols),
    [],
  );
});

test("detects 'my position' phrasing", () => {
  assert.equal(mentionsOpenPositions("how's my position doing?"), true);
});

test("detects 'the trade' phrasing", () => {
  assert.equal(mentionsOpenPositions("what should I do about the trade"), true);
});

test("does not flag unrelated text", () => {
  assert.equal(mentionsOpenPositions("what about NQ right now?"), false);
});
