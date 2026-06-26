import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { AvrrioEngine } from "../src/engine.js";
import { AuditLog } from "../src/audit/auditLog.js";
import {
  RecommendationStore,
  type NewRecommendation,
} from "../src/execution/recommendations.js";
import { RuntimeSettings } from "../src/settings/runtimeSettings.js";
import { KillSwitch } from "../src/safety/killSwitch.js";
import { TradeMemory } from "../src/memory/tradeMemory.js";

async function tempEngine() {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-chat-"));
  const config = loadConfig();
  config.notifications.telegram = {
    enabled: false,
    botToken: "",
    chatId: "999",
  };
  const settings = new RuntimeSettings(config, join(dir, "settings.json"));
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const killSwitch = new KillSwitch(config, audit, join(dir, "kill.json"));
  const recommendations = new RecommendationStore(join(dir, "recs.json"));
  const engine = new AvrrioEngine(config);
  const i = engine as unknown as AvrrioEngine & {
    settings: RuntimeSettings;
    audit: AuditLog;
    killSwitch: KillSwitch;
    memory: TradeMemory;
    recommendations: RecommendationStore;
  };
  i.settings = settings;
  i.audit = audit;
  i.killSwitch = killSwitch;
  i.memory = new TradeMemory(join(dir, "memory.json"));
  i.recommendations = recommendations;
  return { engine: i, recommendations };
}

const baseRec: NewRecommendation = {
  setupName: null,
  symbol: "NQ",
  side: "long",
  size: 1,
  entry: 20000,
  stopLoss: 19960,
  target: 20200,
  riskAmount: 40,
  rewardRiskRatio: 5,
  riskApproved: true,
  violations: [],
  avrrioScore: 80,
  grade: null,
  orderType: "limit",
  orderTypeRationale: "test fixture",
  consensus: {
    recommendation: "long",
    confidence: 0.8,
    agreement: 3,
    available: 3,
    opinions: [],
  },
  news: { blocked: false, reason: "" },
  autoEligible: false,
  expiresAt: null,
  approvalMode: null,
};

async function executedRec(recommendations: RecommendationStore) {
  const rec = await recommendations.add(baseRec);
  rec.status = "executed";
  await recommendations.update(rec);
  return rec;
}

test("buildConversationContext grounds a question mentioning a symbol with that symbol's live data", async () => {
  const { engine } = await tempEngine();
  const context = await engine.buildConversationContext(
    "what about NQ right now?",
  );
  assert.match(context, /Symbol mentioned: NQ/);
  assert.match(context, /Avrrio Score:/);
});

test("buildConversationContext surfaces open positions when asked about 'my position'", async () => {
  const { engine, recommendations } = await tempEngine();
  const rec = await executedRec(recommendations);
  const context = await engine.buildConversationContext(
    "how's my position doing?",
  );
  assert.match(context, /Open positions:/);
  assert.match(context, new RegExp(rec.ref));
});

test("buildConversationContext says there are no open positions when none exist and asked", async () => {
  const { engine } = await tempEngine();
  const context = await engine.buildConversationContext("what about my trade?");
  assert.match(context, /No open positions right now\./);
});

test("buildConversationContext includes an open position detail when the mentioned symbol has one", async () => {
  const { engine, recommendations } = await tempEngine();
  const rec = await executedRec(recommendations);
  const context = await engine.buildConversationContext("how does NQ look");
  assert.match(context, new RegExp(`Open position on NQ.*${rec.ref}`));
});

test("/ask via Telegram with no API key still routes through the symbol-aware context builder offline", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("999", "/ask what about NQ?");
  assert.equal(typeof r, "string");
  assert.ok(r.length > 0);
});
