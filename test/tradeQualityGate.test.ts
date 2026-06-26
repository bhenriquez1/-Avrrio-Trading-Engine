import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { AvrrioEngine } from "../src/engine.js";
import { AuditLog } from "../src/audit/auditLog.js";
import { RecommendationStore } from "../src/execution/recommendations.js";
import { RuntimeSettings } from "../src/settings/runtimeSettings.js";
import { TelegramService } from "../src/telegram/telegramService.js";

async function tempEngine(qualityThreshold: number) {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-quality-"));
  const config = loadConfig();
  config.ai.qualityThreshold = qualityThreshold;
  // Telegram disabled, so sendAlert/sendText never hit the network — we only
  // assert on the audit trail, which records the gating decision either way.
  config.notifications.telegram = { enabled: false, botToken: "", chatId: "" };
  const settings = new RuntimeSettings(config, join(dir, "settings.json"));
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const recommendations = new RecommendationStore(join(dir, "recs.json"));
  const telegram = new TelegramService(config);
  const engine = new AvrrioEngine(config);
  const i = engine as unknown as {
    settings: RuntimeSettings;
    audit: AuditLog;
    recommendations: RecommendationStore;
    telegram: TelegramService;
  };
  i.settings = settings;
  i.audit = audit;
  i.recommendations = recommendations;
  i.telegram = telegram;
  return { engine, audit, recommendations, dir };
}

test("a setup below the Trade Quality Score threshold is suppressed (no Telegram alert), but stays visible as pending", async () => {
  const { engine, audit, recommendations } = await tempEngine(100); // impossible to clear
  const rec = await engine.propose({
    symbol: "NQ",
    side: "long",
    size: 1,
    entry: 20000,
    stopLoss: 19980,
    target: 20060,
  });
  assert.equal(recommendations.get(rec.id)?.status, "pending");
  const entries = await audit.recent(1000);
  assert.ok(
    entries.some((e) => e.type === "telegram.alert_suppressed_low_quality" && e.details.ref === rec.ref),
    "expected a telegram.alert_suppressed_low_quality audit entry",
  );
  assert.ok(
    !entries.some((e) => e.type === "telegram.alert_sent" || e.type === "telegram.alert_skipped"),
    "no alert dispatch should have been attempted",
  );
});

test("a setup at/above the Trade Quality Score threshold is dispatched for approval", async () => {
  const { engine, audit, recommendations } = await tempEngine(0); // always clears
  const rec = await engine.propose({
    symbol: "NQ",
    side: "long",
    size: 1,
    entry: 20000,
    stopLoss: 19980,
    target: 20060,
  });
  assert.equal(recommendations.get(rec.id)?.status, "pending");
  const entries = await audit.recent(1000);
  assert.ok(
    entries.some((e) => e.type === "telegram.alert_skipped" && e.details.ref === rec.ref),
    "expected dispatchAlert to have been attempted (and skipped only because Telegram is disabled in this test)",
  );
  assert.ok(
    !entries.some((e) => e.type === "telegram.alert_suppressed_low_quality"),
    "should not have been suppressed for quality",
  );
});

test("propose() always attaches a grade breakdown to the recommendation", async () => {
  const { engine } = await tempEngine(90);
  const rec = await engine.propose({
    symbol: "NQ",
    side: "long",
    size: 1,
    entry: 20000,
    stopLoss: 19980,
    target: 20060,
  });
  assert.ok(rec.grade, "expected rec.grade to be populated");
  assert.ok(typeof rec.grade?.qualityScore === "number");
  assert.ok(["A+", "A", "B", "C", "D"].includes(rec.grade!.grade));
});

test("propose() always attaches an order type and rationale (never a bare default)", async () => {
  const { engine } = await tempEngine(90);
  const rec = await engine.propose({
    symbol: "NQ",
    side: "long",
    size: 1,
    entry: 20000,
    stopLoss: 19980,
    target: 20060,
  });
  assert.ok(["limit", "stop_market", "market"].includes(rec.orderType));
  assert.ok(rec.orderTypeRationale.length > 0, "expected a human-readable rationale");
});
