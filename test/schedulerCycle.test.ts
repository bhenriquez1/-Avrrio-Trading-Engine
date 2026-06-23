import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { RuntimeSettings } from "../src/settings/runtimeSettings.js";
import type { AvrrioEngine } from "../src/engine.js";
import type { ScanResult } from "../src/scanner/scanner.js";
import type { MarketSnapshot } from "../src/market/marketData.js";
import type { Recommendation } from "../src/execution/recommendations.js";

function result(over: Partial<ScanResult>): ScanResult {
  return {
    symbol: "NQ",
    name: "E-mini Nasdaq 100",
    assetClass: "futures",
    tradable: true,
    score: 90,
    direction: "bullish",
    confidence: 0.9,
    components: { trend: 90, volume: 80, news: 90, momentum: 80, risk: 80 },
    reasons: [],
    newsBlocked: false,
    ...over,
  };
}

function snap(last: number): MarketSnapshot {
  return {
    symbol: "NQ",
    quote: { symbol: "NQ", bid: last, ask: last, last, timestamp: "" },
    bars: [
      { symbol: "NQ", timestamp: "", open: last, high: last + 5, low: last - 5, close: last, volume: 1 },
    ],
    structure: { trend: "up", recentHigh: last + 5, recentLow: last - 5, sma: last },
  };
}

function makeEngine(results: ScanResult[]) {
  const proposed: string[] = [];
  const events: string[] = [];
  let refCounter = 1000;
  const engine = {
    async scan() {
      return results;
    },
    async snapshot() {
      return snap(20000);
    },
    async propose(input: { symbol: string }) {
      proposed.push(input.symbol);
      return { ref: `T-${++refCounter}`, status: "pending" } as Recommendation;
    },
    audit: { async log(type: string) { events.push(type); } },
  } as unknown as AvrrioEngine;
  return { engine, proposed, events };
}

test("only tradable, high-score, directional setups qualify", async () => {
  const config = loadConfig();
  config.notifications.opportunityAlertScore = 85;
  config.scheduler.maxAlerts = 3;
  config.scheduler.minRewardRisk = 2;

  const { engine, proposed } = makeEngine([
    result({ symbol: "NQ", score: 90, direction: "bullish" }), // ok
    result({ symbol: "ES", score: 70, direction: "bullish" }), // score too low
    result({ symbol: "CL", score: 95, direction: "reversal" }), // no clear side
    result({ symbol: "AAPL", score: 99, direction: "bullish", tradable: false }), // watchlist
    result({ symbol: "GC", score: 88, direction: "bearish" }), // ok
  ]);

  const sched = new Scheduler(engine, config, new RuntimeSettings(config));
  const r = await sched.runScanCycle();
  assert.equal(r.scanned, 5);
  assert.deepEqual(proposed.sort(), ["GC", "NQ"]);
  assert.equal(r.alerted, 2);
});

test("alerts are capped at maxAlerts", async () => {
  const config = loadConfig();
  config.notifications.opportunityAlertScore = 85;
  config.scheduler.maxAlerts = 2;
  config.scheduler.minRewardRisk = 2;

  const { engine, proposed } = makeEngine([
    result({ symbol: "NQ" }),
    result({ symbol: "ES" }),
    result({ symbol: "GC" }),
    result({ symbol: "CL" }),
  ]);

  const sched = new Scheduler(engine, config, new RuntimeSettings(config));
  const r = await sched.runScanCycle();
  assert.equal(r.alerted, 2);
  assert.equal(proposed.length, 2);
});

test("audit records scan.started + scan.completed; alert path proposes (-> Telegram)", async () => {
  const config = loadConfig();
  config.notifications.opportunityAlertScore = 85;
  config.scheduler.maxAlerts = 3;
  config.scheduler.minRewardRisk = 2;
  const { engine, proposed, events } = makeEngine([
    result({ symbol: "NQ", score: 90, direction: "bullish" }),
  ]);
  const sched = new Scheduler(engine, config, new RuntimeSettings(config));
  const r = await sched.runScanCycle();
  assert.equal(r.alerted, 1);
  assert.deepEqual(proposed, ["NQ"]); // propose() is what fires the Telegram alert
  assert.ok(events.includes("scan.started"));
  assert.ok(events.includes("scan.completed"));
  assert.ok(events.includes("scheduler.alert"));
  assert.ok(!events.includes("no_qualified_setups"));
});

test("no qualifying setup -> no proposal/alert, logs no_qualified_setups", async () => {
  const config = loadConfig();
  config.notifications.opportunityAlertScore = 85;
  const { engine, proposed, events } = makeEngine([
    result({ symbol: "ES", score: 70, direction: "bullish" }), // below threshold
    result({ symbol: "AAPL", score: 99, tradable: false }),     // watchlist only
  ]);
  const sched = new Scheduler(engine, config, new RuntimeSettings(config));
  const r = await sched.runScanCycle();
  assert.equal(r.alerted, 0);
  assert.equal(proposed.length, 0); // nothing proposed -> no Telegram message
  assert.ok(events.includes("scan.started"));
  assert.ok(events.includes("scan.completed"));
  assert.ok(events.includes("no_qualified_setups"));
  assert.ok(!events.includes("scheduler.alert"));
});
