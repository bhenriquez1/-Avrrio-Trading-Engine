import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { AvrrioEngine } from "../src/engine.js";
import { AuditLog } from "../src/audit/auditLog.js";
import { KillSwitch } from "../src/safety/killSwitch.js";
import { RuntimeSettings } from "../src/settings/runtimeSettings.js";
import { TelegramService } from "../src/telegram/telegramService.js";
import type { NewRecommendation } from "../src/execution/recommendations.js";

/** A minimal risk-approved recommendation for discuss/whatif tests. */
function sampleRec(): NewRecommendation {
  return {
    setupName: "pullback",
    symbol: "NQ",
    side: "long",
    size: 2,
    entry: 20000,
    stopLoss: 19980,
    target: 20060,
    riskAmount: 200,
    rewardRiskRatio: 3,
    riskApproved: true,
    violations: [],
    avrrioScore: 88,
    consensus: { recommendation: "long", confidence: 0.5, agreement: 2, available: 3, opinions: [] },
    news: { blocked: false, reason: "" },
    autoEligible: false,
    expiresAt: null,
    approvalMode: null,
  };
}

async function tempEngine() {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-tg-"));
  const config = loadConfig();
  // Authorized chat = 999; telegram disabled so sendText() no-ops (no network).
  config.notifications.telegram = { enabled: false, botToken: "", chatId: "999" };
  const settings = new RuntimeSettings(config, join(dir, "settings.json"));
  const audit = new AuditLog(join(dir, "audit.jsonl"));
  const killSwitch = new KillSwitch(config, audit, join(dir, "kill.json"));
  const engine = new AvrrioEngine(config);
  const i = engine as unknown as { settings: RuntimeSettings; audit: AuditLog; killSwitch: KillSwitch };
  i.settings = settings; i.audit = audit; i.killSwitch = killSwitch;
  return { engine };
}

test("parseMessage + isAuthorized", () => {
  const config = loadConfig();
  config.notifications.telegram = { enabled: true, botToken: "123:abc", chatId: "999" };
  const svc = new TelegramService(config);
  assert.deepEqual(svc.parseMessage({ message: { chat: { id: 999 }, text: "/status" } }), { chatId: "999", text: "/status" });
  assert.equal(svc.parseMessage({ message: { chat: { id: 1 } } }), null); // no text
  assert.equal(svc.isAuthorized("999"), true);
  assert.equal(svc.isAuthorized("123"), false);
});

test("unauthorized chat is rejected and takes no action", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("123", "/stop");
  assert.equal(r, "unauthorized");
  assert.equal(engine.killSwitch.isEngaged(), false);
});

test("/status returns account + scheduler status", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("999", "/status");
  assert.match(r, /AVRRIO STATUS/);
  assert.match(r, /Kill switch/);
  assert.match(r, /Scheduler/);
});

test("/stop engages emergency stop; /resume needs confirm", async () => {
  const { engine } = await tempEngine();
  const stop = await engine.handleTelegramCommand("999", "/stop");
  assert.match(stop, /ENGAGED/);
  assert.equal(engine.killSwitch.isEngaged(), true);
  // Without confirm, it must NOT clear.
  const noConfirm = await engine.handleTelegramCommand("999", "/resume");
  assert.match(noConfirm, /resume confirm/i);
  assert.equal(engine.killSwitch.isEngaged(), true);
  // With confirm, it clears.
  await engine.handleTelegramCommand("999", "/resume confirm");
  assert.equal(engine.killSwitch.isEngaged(), false);
  engine.scheduler.stop(); // /resume restarts the scanner timer — clear it
});

test("/ask is advisory only and never trades (offline stub)", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("999", "/ask should I buy NQ?");
  assert.match(r, /offline|advisory|Claude/i);
});

test("/help lists commands; unknown command shows help", async () => {
  const { engine } = await tempEngine();
  assert.match(await engine.handleTelegramCommand("999", "/help"), /commands/i);
  assert.match(await engine.handleTelegramCommand("999", "/bogus"), /Unknown command/);
});

test("/approve and /reject require a trade id", async () => {
  const { engine } = await tempEngine();
  assert.match(await engine.handleTelegramCommand("999", "/approve"), /Usage: \/approve/);
  assert.match(await engine.handleTelegramCommand("999", "/reject"), /Usage: \/reject/);
});

test("new commands respond (scan/why/diag/last_signal/risk/settings/pause)", async () => {
  const { engine } = await tempEngine();
  assert.match(await engine.handleTelegramCommand("999", "/diag"), /PIPELINE DIAGNOSTICS/);
  assert.match(await engine.handleTelegramCommand("999", "/last_signal"), /LAST SIGNAL/);
  assert.match(await engine.handleTelegramCommand("999", "/risk"), /RISK LIMITS/);
  assert.match(await engine.handleTelegramCommand("999", "/settings"), /SETTINGS/);
  assert.match(await engine.handleTelegramCommand("999", "/why"), /WHY NO TRADE/);
  // /scan runs a cycle and reports (demo data: no qualifying setup).
  assert.match(await engine.handleTelegramCommand("999", "/scan now"), /Scan complete/);
});

test("/pause then /resume toggles the scanner", async () => {
  const { engine } = await tempEngine();
  assert.match(await engine.handleTelegramCommand("999", "/pause"), /paused/i);
  assert.equal(engine.scheduler.enabled, false);
  assert.match(await engine.handleTelegramCommand("999", "/resume"), /resumed/i);
  assert.equal(engine.scheduler.enabled, true);
  engine.scheduler.stop(); // clear the setInterval so the test process can exit
});

test("plain (non-slash) text is routed to the AI assistant (advisory)", async () => {
  const { engine } = await tempEngine();
  const r = await engine.handleTelegramCommand("999", "Why no trade right now?");
  // No ANTHROPIC_API_KEY in tests -> advisory offline stub, never trades.
  assert.match(r, /offline|advisory|Claude/i);
});

test("/discuss and /whatif show usage without args", async () => {
  const { engine } = await tempEngine();
  assert.match(await engine.handleTelegramCommand("999", "/discuss"), /Usage: \/discuss/);
  assert.match(await engine.handleTelegramCommand("999", "/whatif"), /Usage: \/whatif/);
});

test("/discuss a specific trade is advisory only (offline stub)", async () => {
  const { engine } = await tempEngine();
  const rec = await engine.recommendations.add(sampleRec());
  const r = await engine.handleTelegramCommand("999", `/discuss ${rec.ref} why not buy now?`);
  assert.match(r, new RegExp(rec.ref));
  // No ANTHROPIC_API_KEY in tests -> advisory offline stub, never trades.
  assert.match(r, /offline|advisory|Claude/i);
});

test("/whatif recomputes R:R deterministically (no AI key needed)", async () => {
  const { engine } = await tempEngine();
  const rec = await engine.recommendations.add(sampleRec());
  const r = await engine.handleTelegramCommand("999", `/whatif ${rec.ref} move my stop to 19990`);
  assert.match(r, /what-if/i);
  assert.match(r, /R:R/);
});

test("/debate produces Bull/Bear/Verdict for a trade (no AI key needed)", async () => {
  const { engine } = await tempEngine();
  const rec = await engine.recommendations.add(sampleRec());
  const r = await engine.handleTelegramCommand("999", `/debate ${rec.ref}`);
  assert.match(r, /Bull case:/);
  assert.match(r, /Bear case:/);
  assert.match(r, /Final verdict/);
});

test("/debate falls back to the latest signal when no ref is given", async () => {
  const { engine } = await tempEngine();
  await engine.recommendations.add(sampleRec());
  const r = await engine.handleTelegramCommand("999", "/debate");
  assert.match(r, /DEBATE/);
});

test("/coach reviews a trade against discipline rules (no AI key needed)", async () => {
  const { engine } = await tempEngine();
  const rec = await engine.recommendations.add(sampleRec());
  const r = await engine.handleTelegramCommand("999", `/coach ${rec.ref}`);
  assert.match(r, /TRADE COACH/);
  assert.match(r, /Discipline grade/);
});

test("whatIf throws for an unknown ref", async () => {
  const { engine } = await tempEngine();
  await assert.rejects(() => engine.whatIf("T-9999", "move stop to 1"), /No recommendation/);
});

test("pipelineDiagnostics reports the key pipeline stages", async () => {
  const { engine } = await tempEngine();
  const d = engine.pipelineDiagnostics();
  assert.ok("scheduler" in d && "telegram" in d && "ai" in d && "topstepx" in d);
  assert.equal(typeof d.scheduler.intervalMinutes, "number");
  assert.equal(d.trading.paper, !d.trading.liveTrading);
  assert.match(d.process, /scheduler runs in-process/i);
});
