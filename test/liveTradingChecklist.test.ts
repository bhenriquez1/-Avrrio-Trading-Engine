import assert from "node:assert/strict";
import { test } from "node:test";
import { AvrrioEngine } from "../src/engine.js";
import { loadConfig } from "../src/config.js";

test("live trading cannot be enabled until the safety checklist passes", async () => {
  const config = loadConfig();
  config.topstep.username = "";
  config.topstep.apiKey = "";
  config.safety.dailyMaxLoss = 1000;
  config.safety.maxPositionSize = 1;
  config.execution.liveTradingEnabled = false;
  const engine = new AvrrioEngine(config);

  await assert.rejects(
    () => engine.setLiveTrading(true, "test"),
    /Live trading is locked until all checks pass/,
  );
  assert.equal(engine.isLiveTradingEnabled(), false);

  const checklist = await engine.liveTradingChecklist(false);
  assert.equal(checklist.ready, false);
  assert.ok(checklist.blockers.includes("ProjectX auth must pass"));
  assert.ok(checklist.blockers.includes("Telegram test must pass"));
  assert.ok(checklist.blockers.includes("At least one paper/simulated approval test must succeed"));
});
