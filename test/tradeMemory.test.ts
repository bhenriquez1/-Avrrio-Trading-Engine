import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradeMemory } from "../src/memory/tradeMemory.js";

async function freshMemory() {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-mem-"));
  return new TradeMemory(join(dir, "memory.json"));
}

/** Add `wins` winners and `losses` losers for a setup/side. */
async function seed(
  mem: TradeMemory,
  setup: string,
  side: "long" | "short",
  wins: number,
  losses: number,
  entryHour = 10,
) {
  for (let i = 0; i < wins; i++) await mem.add({ symbol: "NQ", setup, side, score: 88, rewardRisk: 3, entryHour, pnl: 100 });
  for (let i = 0; i < losses; i++) await mem.add({ symbol: "NQ", setup, side, score: 88, rewardRisk: 3, entryHour, pnl: -100 });
}

test("derives result from pnl and normalises setup", async () => {
  const mem = await freshMemory();
  const w = await mem.add({ symbol: "NQ", setup: "Pullback", side: "long", score: 90, rewardRisk: 3, entryHour: 9, pnl: 120 });
  assert.equal(w.result, "win");
  assert.equal(w.setup, "pullback");
  const l = await mem.add({ symbol: "NQ", setup: null, side: "short", score: 70, rewardRisk: 1, entryHour: 9, pnl: -50 });
  assert.equal(l.result, "loss");
  assert.equal(l.setup, "unknown");
});

test("bySetup win rates are computed per cohort", async () => {
  const mem = await freshMemory();
  await seed(mem, "pullback", "long", 7, 3); // 70%
  await seed(mem, "breakout", "long", 3, 7); // 30%
  const setups = mem.bySetup();
  const pb = setups.find((s) => s.key === "pullback");
  const bo = setups.find((s) => s.key === "breakout");
  assert.equal(pb?.winRate, 0.7);
  assert.equal(bo?.winRate, 0.3);
});

test("assess warns on a historically weak setup", async () => {
  const mem = await freshMemory();
  await seed(mem, "breakout", "long", 3, 7); // 30% over 10
  const a = mem.assess({ setup: "breakout", side: "long", score: 88 });
  assert.equal(a.matched, true);
  assert.equal(a.level, "warn");
  assert.match(a.message, /struggled with/i);
  assert.equal(a.sampleSize, 10);
});

test("assess is favorable on a strong setup", async () => {
  const mem = await freshMemory();
  await seed(mem, "pullback", "long", 8, 2); // 80%
  const a = mem.assess({ setup: "pullback", side: "long" });
  assert.equal(a.level, "favorable");
});

test("assess reports insufficient data below the sample floor", async () => {
  const mem = await freshMemory();
  await seed(mem, "pullback", "long", 1, 1);
  const a = mem.assess({ setup: "pullback", side: "long" });
  assert.equal(a.matched, false);
  assert.equal(a.level, "insufficient");
});

test("assess with no setup label cannot match", async () => {
  const mem = await freshMemory();
  await seed(mem, "pullback", "long", 8, 2);
  const a = mem.assess({ setup: null, side: "long" });
  assert.equal(a.matched, false);
  assert.equal(a.level, "insufficient");
});

test("insights contrast best vs worst setup", async () => {
  const mem = await freshMemory();
  await seed(mem, "pullback", "long", 7, 3);
  await seed(mem, "breakout", "long", 3, 7);
  const ins = mem.insights();
  assert.ok(ins.some((i) => /pullback/.test(i) && /breakout/.test(i)));
});

test("records persist and reload from disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-mem-"));
  const path = join(dir, "memory.json");
  const a = new TradeMemory(path);
  await seed(a, "pullback", "long", 2, 1);
  const b = new TradeMemory(path);
  await b.load();
  assert.equal(b.count(), 3);
  assert.equal(b.overall().wins, 2);
});
