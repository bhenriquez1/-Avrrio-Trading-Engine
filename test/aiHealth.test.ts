import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { ClaudeAnalysisService } from "../src/ai/claudeAnalysis.js";

test("AI health reports offline + reason when no ANTHROPIC_API_KEY", () => {
  const config = loadConfig();
  config.ai.anthropicApiKey = "";
  const svc = new ClaudeAnalysisService(config);
  const h = svc.health();
  assert.equal(h.status, "offline");
  assert.equal(h.enabled, false);
  assert.equal(h.model, config.ai.claudeModel);
  assert.equal(h.lastSuccessAt, null);
  assert.match(h.lastError ?? "", /ANTHROPIC_API_KEY/);
});

test("AI health reports online + current model when key is set", () => {
  const config = loadConfig();
  config.ai.anthropicApiKey = "sk-ant-test";
  config.ai.claudeModel = "claude-opus-4-8";
  const h = new ClaudeAnalysisService(config).health();
  assert.equal(h.status, "online");
  assert.equal(h.enabled, true);
  assert.equal(h.model, "claude-opus-4-8");
});

test("/ask is advisory offline stub when no key (never throws, never trades)", async () => {
  const config = loadConfig();
  config.ai.anthropicApiKey = "";
  const r = await new ClaudeAnalysisService(config).ask("why no trade?", "ctx");
  assert.match(r, /offline/i);
});

test("scan interval default is 5 minutes", () => {
  const prev = process.env.SCAN_INTERVAL_MINUTES;
  delete process.env.SCAN_INTERVAL_MINUTES;
  try {
    assert.equal(loadConfig().scheduler.intervalMinutes, 5);
  } finally {
    if (prev !== undefined) process.env.SCAN_INTERVAL_MINUTES = prev;
  }
});
