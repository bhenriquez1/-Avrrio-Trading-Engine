import { AuditLog } from "./audit/auditLog.js";
import { Auth } from "./auth/auth.js";
import { ClaudeAnalysisService } from "./ai/claudeAnalysis.js";
import { ConsensusEngine } from "./ai/consensus.js";
import { loadConfig, configWarnings, type AvrrioConfig } from "./config.js";
import { OrderExecutor } from "./execution/orderExecutor.js";
import {
  RecommendationStore,
  type ApprovalMode,
  type Recommendation,
} from "./execution/recommendations.js";
import { MarketDataReader, type MarketSnapshot } from "./market/marketData.js";
import { NewsReader } from "./news/newsReader.js";
import { NotificationManager } from "./notifications/notifier.js";
import { EmailNotifier } from "./notifications/emailNotifier.js";
import { TelegramService } from "./telegram/telegramService.js";
import { RiskManager, type RiskContext } from "./risk/riskManager.js";
import { pointValue } from "./risk/rules.js";
import { RuntimeSettings } from "./settings/runtimeSettings.js";
import { Scheduler } from "./scheduler/scheduler.js";
import {
  Scanner,
  scoreSnapshot,
  type ScanOptions,
  type ScanResult,
} from "./scanner/scanner.js";
import { KillSwitch } from "./safety/killSwitch.js";
import { findSetup, withinAllowedHours } from "./setups/index.js";
import { findSymbol, isTradable } from "./symbols/registry.js";
import { TradeJournal } from "./journal/tradeJournal.js";
import { TopstepClient } from "./topstep/client.js";
import { sendSms, samePhone, smsMissing } from "./sms/smsClient.js";
import { parseSmsCommand, type SmsCommand } from "./sms/inbound.js";
import {
  formatOpportunitySms,
  formatSignalSms,
} from "./sms/messages.js";
import type {
  AccountSummary,
  AuthTestResult,
  OrderResult,
  Side,
  TopstepStatus,
  TradeIdea,
  TradingMode,
} from "./types.js";

export interface LiveTradingChecklist {
  projectxAuth: boolean;
  tokenReceived: boolean;
  accountFound: boolean;
  telegramTestPassed: boolean;
  emergencyStopTested: boolean;
  maxDailyLossConfigured: boolean;
  maxPositionSizeConfigured: boolean;
  paperApprovalTestPassed: boolean;
  ready: boolean;
  blockers: string[];
}

/** Consolidated, operator-facing live-trading readiness report. */
export interface ReadinessReport {
  projectxAuth: boolean;
  accountSync: {
    connected: boolean;
    accountId: string;
    buyingPower: number;
    dailyPnL: number;
    lastSyncTime: string | null;
  };
  telegram: boolean;
  emergencyStop: boolean;
  riskLimits: { dailyLoss: boolean; positionSize: boolean };
  paperApproval: boolean;
  blockers: string[];
  /** Checklist items passed / total, plus a 0-100 percentage. */
  passed: number;
  total: number;
  scorePct: number;
  /** Always false during the safety-validation phase. */
  liveTradingEnabled: boolean;
  /** True only when every check passes (live trading may then be enabled). */
  ready: boolean;
}

export interface ProposeInput extends TradeIdea {
  /** Optional predefined setup this idea belongs to. */
  setupName?: string;
  /** Operator override to bypass a news block (manual only). */
  newsOverride?: boolean;
}

/**
 * Composition root tying together the read-only client, market reader, AI
 * consensus, risk manager, journal, recommendation store, order executor, kill
 * switch, news reader, auth, and audit log.
 */
export class AvrrioEngine {
  readonly config: AvrrioConfig;
  readonly client: TopstepClient;
  readonly market: MarketDataReader;
  readonly risk: RiskManager;
  readonly journal: TradeJournal;
  readonly claude: ClaudeAnalysisService;
  readonly consensus: ConsensusEngine;
  readonly news: NewsReader;
  readonly scanner: Scanner;
  readonly audit: AuditLog;
  readonly killSwitch: KillSwitch;
  readonly recommendations: RecommendationStore;
  readonly executor: OrderExecutor;
  readonly notifications: NotificationManager;
  readonly telegram: TelegramService;
  readonly settings: RuntimeSettings;
  readonly scheduler: Scheduler;
  readonly auth: Auth;
  // Validation flags (Telegram/Emergency Stop/paper approval) are persisted in
  // RuntimeSettings so they survive restarts; auth/token/account below stay
  // live-checked so a broken connection always reflects reality.
  private lastAuthTest: AuthTestResult | null = null;

  constructor(config = loadConfig()) {
    this.config = config;
    this.audit = new AuditLog();
    this.settings = new RuntimeSettings(config);
    this.client = new TopstepClient(config);
    this.market = new MarketDataReader(this.client);
    this.risk = new RiskManager();
    this.journal = new TradeJournal();
    this.claude = new ClaudeAnalysisService(config);
    this.consensus = new ConsensusEngine(config);
    this.news = new NewsReader(config);
    this.scanner = new Scanner(this.market, this.news);
    this.killSwitch = new KillSwitch(config, this.audit);
    this.recommendations = new RecommendationStore();
    this.executor = new OrderExecutor(
      this.settings,
      this.client,
      this.killSwitch,
      this.recommendations,
      this.audit,
    );
    // SMS and Telegram have dedicated, fully-formatted alert paths, so only email
    // is registered here (avoids duplicate notifications).
    this.notifications = new NotificationManager(config, [new EmailNotifier(config)]);
    this.telegram = new TelegramService(config);
    this.auth = new Auth(config);
    this.scheduler = new Scheduler(this, config, this.settings);
  }

  async init(): Promise<void> {
    await Promise.all([
      this.journal.load(),
      this.killSwitch.load(),
      this.recommendations.load(),
      this.settings.load(),
    ]);
  }

  warnings(): string[] {
    // Reflect runtime-toggled state (persisted), not just env defaults, so the
    // full-auto / live-trading safety warnings stay accurate after a switch.
    return configWarnings(this.config, {
      liveTradingEnabled: this.settings.isLiveTradingEnabled(),
      tradingMode: this.settings.getTradingMode(),
    });
  }

  getAccount(): Promise<AccountSummary> {
    return this.client.getAccount();
  }

  snapshot(symbol: string): Promise<MarketSnapshot> {
    return this.market.snapshot(symbol);
  }

  /** Scan and rank the symbol universe by Avrrio Score. */
  scan(options?: ScanOptions): Promise<ScanResult[]> {
    return this.scanner.scan(options);
  }

  /**
   * Generate a recommendation: AI consensus + news + full risk stack. Stores it
   * as pending (or blocked). In semi-autonomous mode, auto-executes only when
   * every gate passes.
   */
  async propose(input: ProposeInput): Promise<Recommendation> {
    const account = await this.getAccount();
    const snapshot = await this.snapshot(input.symbol);
    const setup = input.setupName ? findSetup(input.setupName) : undefined;

    const [consensus, news] = await Promise.all([
      this.consensus.evaluate(snapshot, account),
      this.news.assess(input.symbol),
    ]);

    const context: RiskContext = {
      symbolTradable: isTradable(input.symbol),
      killSwitchEngaged: this.killSwitch.isEngaged(),
      news,
      newsOverride: input.newsOverride ?? false,
      tradesToday: this.recommendations.executedToday(),
      duplicateOpen: this.recommendations.hasOpenDuplicate(
        input.symbol,
        input.side,
      ),
      withinAllowedHours: setup ? withinAllowedHours(setup) : undefined,
      safety: {
        maxPositionSize: this.config.safety.maxPositionSize,
        maxTradesPerDay: this.config.safety.maxTradesPerDay,
        maxRiskPerTrade: this.config.safety.maxRiskPerTrade,
        maxDailyLoss: this.config.safety.dailyMaxLoss,
      },
    };

    const assessment = this.risk.assess(input, account, context);
    const { score: avrrioScore } = scoreSnapshot(snapshot, news.blocked);

    const consensusAgrees =
      consensus.recommendation === input.side &&
      consensus.agreement >= 2 &&
      consensus.confidence >= this.config.ai.confidenceThreshold;

    const autoEligible =
      this.settings.getTradingMode() === "full_auto" &&
      assessment.approved &&
      !this.killSwitch.isEngaged() &&
      !news.blocked &&
      consensusAgrees;

    const rec = await this.recommendations.add({
      setupName: input.setupName ?? null,
      symbol: input.symbol,
      side: input.side,
      size: input.size,
      entry: input.entry,
      stopLoss: input.stopLoss,
      target: input.target,
      riskAmount: assessment.riskAmount,
      rewardRiskRatio: assessment.rewardRiskRatio,
      riskApproved: assessment.approved,
      violations: assessment.violations,
      avrrioScore,
      consensus: {
        recommendation: consensus.recommendation,
        confidence: consensus.confidence,
        agreement: consensus.agreement,
        available: consensus.available,
        opinions: consensus.opinions,
      },
      news,
      autoEligible,
      expiresAt: new Date(
        Date.now() + this.config.queue.approvalExpiryMinutes * 60_000,
      ).toISOString(),
      approvalMode: null,
    });

    await this.audit.log("recommendation.created", "system", {
      recommendationId: rec.id,
      symbol: rec.symbol,
      side: rec.side,
      riskApproved: rec.riskApproved,
      autoEligible,
      consensus: consensus.recommendation,
      agreement: consensus.agreement,
    });

    // Mirror into the journal for the historical record.
    await this.journal.record(input, assessment.approved);

    if (autoEligible) {
      // Semi-autonomous: every gate passed, execute now.
      await this.executor.execute(rec, "system");
    } else if (rec.status === "pending") {
      // Manual/pre-approved: alert the operator so they can approve from a phone.
      await this.dispatchAlert(rec);
    }

    return rec;
  }

  /**
   * Sends a trade alert to Telegram only. Telegram carries the full trade detail
   * plus one-tap APPROVE / REJECT / STOP ALL buttons. SMS remains disabled unless
   * an operator explicitly re-enables SMS endpoints for legacy use.
   */
  private async dispatchAlert(rec: Recommendation): Promise<void> {
    if (!this.telegram.enabled) {
      await this.audit.log("telegram.alert_skipped", "system", {
        ref: rec.ref,
        info: "Telegram not configured; SMS fallback disabled.",
      });
      return;
    }
    const r = await this.telegram.sendAlert(rec);
    await this.audit.log("telegram.alert_sent", "system", {
      ref: rec.ref,
      ok: r.ok,
      info: r.info,
    });
  }

  /**
   * Applies an approval action (from a Telegram button or elsewhere) through the
   * same safety gates as SMS approval. Returns the operator confirmation text.
   */
  async approvalAction(
    action: "approve" | "reject" | "stopall" | "details",
    ref: string,
  ): Promise<string> {
    if (action === "approve") {
      if (this.settings.getTradingMode() === "advisor") {
        await this.audit.log("approve.advisor_only", "operator", { ref });
        return `ℹ️ Advisor mode: Avrrio does not place orders. Enter ${ref} manually in TopstepX if you want it.`;
      }
      return this.approveBySms(ref);
    }
    if (action === "reject") return this.rejectBySms(ref);
    if (action === "details") return this.telegramDetails(ref);
    await this.engageKill("emergency stop (button)", "operator");
    return "🛑 Emergency Stop activated. No trades can execute.";
  }

  // --- Telegram (primary alert channel) ---------------------------------
  async telegramTest() {
    const r = await this.telegram.sendTest();
    if (r.ok) await this.settings.markValidation("telegramTestPassed");
    await this.audit.log("telegram.test_sent", "operator", { ok: r.ok, info: r.info });
    return r;
  }
  telegramDebug() {
    return this.telegram.debug();
  }
  telegramSetWebhook(url: string) {
    return this.telegram.setWebhook(url);
  }
  /** Process an inbound Telegram webhook (button press). */
  async handleTelegramWebhook(body: unknown): Promise<void> {
    const cb = this.telegram.parseCallback(body);
    if (!cb) return;
    await this.telegram.handleCallback(cb, (action, ref) =>
      this.approvalAction(action, ref),
    );
  }

  /** Sends the 🚨 signal SMS with YES/NO reply instructions, and audits it. */
  private async sendSignalSms(rec: Recommendation): Promise<void> {
    if (!this.config.notifications.sms.enabled) return;
    const result = await sendSms(this.config, formatSignalSms(rec));
    await this.audit.log("sms.signal_sent", "system", {
      ref: rec.ref,
      ok: result.ok,
      info: result.info,
    });
  }

  /**
   * Approve a recommendation.
   * - `immediate` (Mode 1, Manual): execute right away.
   * - `pre-approved` (Mode 2): arm it; the maintenance loop executes it when the
   *   entry is reached AND risk/news/kill-switch still pass, before it expires.
   */
  async approve(
    id: string,
    actor: string,
    mode: ApprovalMode = "immediate",
  ): Promise<{ mode: ApprovalMode; armed: boolean; result?: OrderResult }> {
    const rec = this.requireLiveRec(id);
    // Advisor mode: never place an order. Leave the recommendation untouched
    // (still pending, so it can be entered manually) and surface a clean
    // acknowledgement rather than persisting it as "blocked" via the executor.
    if (this.settings.getTradingMode() === "advisor") {
      await this.audit.log("approve.advisor_only", actor, {
        recommendationId: rec.id,
        ref: rec.ref,
      });
      throw new Error(
        `Advisor mode: Avrrio does not place orders. Enter ${rec.ref} manually in TopstepX if you want it.`,
      );
    }
    rec.approvalMode = mode;
    rec.decidedBy = actor;
    rec.decidedAt = new Date().toISOString();

    if (mode === "pre-approved") {
      rec.status = "armed";
      await this.recommendations.update(rec);
      await this.audit.log("recommendation.armed", actor, {
        recommendationId: rec.id,
        expiresAt: rec.expiresAt,
      });
      // It may already satisfy its conditions — try once immediately.
      const result = await this.tryTrigger(rec);
      return { mode, armed: result === undefined, ...(result ? { result } : {}) };
    }

    const result = await this.executor.execute(rec, actor);
    if (result.paper) await this.settings.markValidation("paperApprovalTestPassed");
    return { mode, armed: false, result };
  }

  async reject(id: string, actor: string, reason = ""): Promise<void> {
    const rec = this.recommendations.get(id);
    if (!rec) throw new Error(`Recommendation ${id} not found.`);
    await this.executor.reject(rec, actor, reason);
  }

  /** Token-gated approval used by notification links (no dashboard login). */
  approveByToken(id: string, token: string, mode: ApprovalMode) {
    const rec = this.requireLiveRec(id);
    if (rec.approvalToken !== token) throw new Error("Invalid approval token.");
    return this.approve(id, "phone", mode);
  }

  async rejectByToken(id: string, token: string): Promise<void> {
    const rec = this.recommendations.get(id);
    if (!rec || rec.approvalToken !== token) {
      throw new Error("Invalid approval token.");
    }
    await this.executor.reject(rec, "phone", "rejected via link");
  }

  /**
   * Maintenance tick: expire stale pending/armed recommendations and execute any
   * armed (pre-approved) trade whose entry has been reached and whose risk/news/
   * kill-switch checks still pass. Call this on an interval.
   */
  async maintain(): Promise<void> {
    const now = Date.now();
    for (const rec of this.recommendations.list()) {
      if (rec.status !== "pending" && rec.status !== "armed") continue;
      if (rec.expiresAt && now > new Date(rec.expiresAt).getTime()) {
        rec.status = "expired";
        await this.recommendations.update(rec);
        await this.audit.log("recommendation.expired", "system", {
          recommendationId: rec.id,
        });
      }
    }
    for (const rec of this.recommendations.armed()) {
      await this.tryTrigger(rec);
    }
  }

  private requireLiveRec(id: string): Recommendation {
    const rec = this.recommendations.get(id);
    if (!rec) throw new Error(`Recommendation ${id} not found.`);
    if (rec.expiresAt && Date.now() > new Date(rec.expiresAt).getTime()) {
      throw new Error("Recommendation has expired.");
    }
    return rec;
  }

  /**
   * If an armed trade's entry is reached and all conditions still pass, execute
   * it and return the order result; otherwise return undefined (stays armed).
   */
  private async tryTrigger(
    rec: Recommendation,
  ): Promise<OrderResult | undefined> {
    if (rec.status !== "armed") return undefined;

    const quote = await this.client.getQuote(rec.symbol);
    const tol = this.config.queue.entryTriggerTolerancePct;
    const reached =
      rec.entry === 0 || Math.abs(quote.last - rec.entry) / rec.entry <= tol;
    if (!reached) return undefined;

    // Re-check live conditions before pulling the trigger.
    const account = await this.getAccount();
    const news = await this.news.assess(rec.symbol);
    const context: RiskContext = {
      symbolTradable: isTradable(rec.symbol),
      killSwitchEngaged: this.killSwitch.isEngaged(),
      news,
      tradesToday: this.recommendations.executedToday(),
      safety: {
        maxPositionSize: this.config.safety.maxPositionSize,
        maxTradesPerDay: this.config.safety.maxTradesPerDay,
        maxRiskPerTrade: this.config.safety.maxRiskPerTrade,
        maxDailyLoss: this.config.safety.dailyMaxLoss,
      },
    };
    const recheck = this.risk.assess(rec, account, context);
    if (!recheck.approved) {
      await this.audit.log("pre_approved.trigger_blocked", "system", {
        recommendationId: rec.id,
        reasons: recheck.violations.map((v) => v.rule),
      });
      return undefined; // stay armed; will expire if conditions never clear
    }

    return this.executor.execute(rec, "system(pre-approved)");
  }

  async engageKill(reason: string, actor: string): Promise<void> {
    await this.killSwitch.engage(reason, actor);
    await this.settings.markValidation("emergencyStopTested");
    if (this.config.notifications.sms.enabled) {
      const r = await sendSms(
        this.config,
        "🛑 Emergency Stop activated. No trades can execute.",
      );
      await this.audit.log("sms.emergency_sent", actor, { ok: r.ok, info: r.info });
    }
  }

  disengageKill(actor: string) {
    return this.killSwitch.disengage(actor);
  }

  // --- TopstepX connection ----------------------------------------------
  topstepxStatus(): TopstepStatus {
    return this.client.status();
  }
  topstepxConnect(): Promise<TopstepStatus> {
    return this.client.connect();
  }
  topstepxDisconnect(): TopstepStatus {
    return this.client.disconnect();
  }
  topstepxSync(): Promise<TopstepStatus> {
    return this.client.sync();
  }
  async topstepxAuthTest(): Promise<AuthTestResult> {
    const r = await this.client.authTest();
    this.lastAuthTest = r;
    return r;
  }

  // --- runtime trading mode (paper/live) toggle -------------------------
  isLiveTradingEnabled(): boolean {
    return this.settings.isLiveTradingEnabled();
  }
  async setLiveTrading(enabled: boolean, actor: string): Promise<void> {
    if (enabled) {
      const checklist = await this.liveTradingChecklist(true);
      if (!checklist.ready) {
        await this.audit.log("settings.live_trading_blocked", actor, { blockers: checklist.blockers });
        throw new Error(
          `Live trading is locked until all checks pass: ${checklist.blockers.join("; ")}`,
        );
      }
    }
    await this.settings.setLiveTrading(enabled);
    await this.audit.log("settings.live_trading", actor, { enabled });
  }

  async liveTradingChecklist(refreshAuth = false): Promise<LiveTradingChecklist> {
    if (refreshAuth) {
      this.lastAuthTest = await this.client.authTest();
    }
    const auth = this.lastAuthTest;
    const status = this.client.status();
    const v = this.settings.getValidations();
    const maxDailyLossConfigured = this.config.safety.dailyMaxLoss > 0 || status.maxDailyLoss > 0;
    const maxPositionSizeConfigured = this.config.safety.maxPositionSize > 0;
    const checks: Array<[keyof Omit<LiveTradingChecklist, "ready" | "blockers">, boolean, string]> = [
      ["projectxAuth", !!auth?.ok, "ProjectX auth must pass"],
      ["tokenReceived", !!auth?.tokenReceived, "Auth Test must show token received yes"],
      ["accountFound", !!auth?.accountFound, "Auth Test must show account found yes"],
      ["telegramTestPassed", v.telegramTestPassed, "Telegram test must pass"],
      ["emergencyStopTested", v.emergencyStopTested, "Emergency Stop must be tested"],
      ["maxDailyLossConfigured", maxDailyLossConfigured, "Max daily loss must be configured"],
      ["maxPositionSizeConfigured", maxPositionSizeConfigured, "Max position size must be configured"],
      ["paperApprovalTestPassed", v.paperApprovalTestPassed, "At least one paper/simulated approval test must succeed"],
    ];
    const blockers = checks.filter(([, ok]) => !ok).map(([, , label]) => label);
    return {
      projectxAuth: !!auth?.ok,
      tokenReceived: !!auth?.tokenReceived,
      accountFound: !!auth?.accountFound,
      telegramTestPassed: v.telegramTestPassed,
      emergencyStopTested: v.emergencyStopTested,
      maxDailyLossConfigured,
      maxPositionSizeConfigured,
      paperApprovalTestPassed: v.paperApprovalTestPassed,
      ready: blockers.length === 0,
      blockers,
    };
  }

  /** Clear the operator-completed safety validations so they must be re-tested. */
  async resetSafetyValidations(actor: string): Promise<void> {
    await this.settings.resetValidations();
    await this.audit.log("safety.validations_reset", actor, {});
  }

  /**
   * Consolidated readiness report: re-checks auth live, folds in the persisted
   * validations + risk-limit config + account-sync snapshot, and scores overall
   * readiness. Read-only — never enables live trading or places an order.
   */
  async readinessReport(refreshAuth = true): Promise<ReadinessReport> {
    const c = await this.liveTradingChecklist(refreshAuth);
    const s = this.client.status();
    const items = [
      c.projectxAuth,
      c.tokenReceived,
      c.accountFound,
      c.telegramTestPassed,
      c.emergencyStopTested,
      c.maxDailyLossConfigured,
      c.maxPositionSizeConfigured,
      c.paperApprovalTestPassed,
    ];
    const passed = items.filter(Boolean).length;
    const total = items.length;
    return {
      projectxAuth: c.projectxAuth && c.tokenReceived && c.accountFound,
      accountSync: {
        connected: s.connected && s.authenticated,
        accountId: s.accountId,
        buyingPower: s.availableBuyingPower,
        dailyPnL: s.dailyPnL,
        lastSyncTime: s.lastSyncTime,
      },
      telegram: c.telegramTestPassed,
      emergencyStop: c.emergencyStopTested,
      riskLimits: {
        dailyLoss: c.maxDailyLossConfigured,
        positionSize: c.maxPositionSizeConfigured,
      },
      paperApproval: c.paperApprovalTestPassed,
      blockers: c.blockers,
      passed,
      total,
      scorePct: Math.round((passed / total) * 100),
      liveTradingEnabled: this.isLiveTradingEnabled(),
      ready: c.ready,
    };
  }

  /** Telegram/console-friendly readiness summary (no secrets). */
  readinessReportText(r: ReadinessReport): string {
    const yn = (b: boolean) => (b ? "✅" : "⚠️");
    return [
      "📋 AVRRIO LIVE-TRADING READINESS",
      "",
      `${yn(r.projectxAuth)} ProjectX auth (token + account)`,
      `${yn(r.accountSync.connected)} Account sync — ID ${r.accountSync.accountId || "—"} · BP $${r.accountSync.buyingPower.toLocaleString()} · Day P&L ${r.accountSync.dailyPnL >= 0 ? "+" : ""}$${r.accountSync.dailyPnL.toLocaleString()}`,
      `${yn(r.telegram)} Telegram alert test`,
      `${yn(r.emergencyStop)} Emergency Stop tested`,
      `${yn(r.riskLimits.dailyLoss)} Max daily loss configured`,
      `${yn(r.riskLimits.positionSize)} Max position size configured`,
      `${yn(r.paperApproval)} Paper approval workflow`,
      "",
      `Score: ${r.passed}/${r.total} (${r.scorePct}%)`,
      `Live trading: ${r.liveTradingEnabled ? "ENABLED" : "disabled"} · Overall: ${r.ready ? "READY" : "NOT READY"}`,
      r.blockers.length ? `Blockers: ${r.blockers.join("; ")}` : "No blockers remaining.",
    ].join("\n");
  }

  /** Build + broadcast the readiness report to the operator's channels. */
  async sendReadinessReport(actor: string): Promise<ReadinessReport> {
    const report = await this.readinessReport(true);
    await this.broadcast(this.readinessReportText(report), "readiness");
    await this.audit.log("readiness.sent", actor, {
      score: report.scorePct,
      ready: report.ready,
    });
    return report;
  }

  // --- trading mode (advisor / telegram_approval / full_auto) -----------
  getTradingMode(): TradingMode {
    return this.settings.getTradingMode();
  }
  async setTradingMode(mode: TradingMode, actor: string): Promise<void> {
    await this.settings.setTradingMode(mode);
    await this.audit.log("settings.trading_mode", actor, { mode });
  }

  /** Exact SMS env vars that are missing (empty when fully configured). */
  smsMissing(): string[] {
    return smsMissing(this.config);
  }

  async setScheduler(
    enabled: boolean,
    intervalMinutes: number | undefined,
    actor: string,
  ): Promise<void> {
    await this.scheduler.configure(enabled, intervalMinutes);
    await this.audit.log("settings.scheduler", actor, { enabled, intervalMinutes });
  }

  /**
   * Execute a stored recommendation by id/ref, gated on TopstepX readiness.
   * In LIVE mode the broker must be connected, authenticated, and active; in
   * paper mode a simulated fill is allowed so the workflow is testable.
   */
  async executeRecommendation(idOrRef: string, actor: string) {
    const rec = this.requireLiveRec(idOrRef);
    this.assertBrokerReady();
    return this.executor.execute(rec, actor);
  }

  private assertBrokerReady(): void {
    if (!this.settings.isLiveTradingEnabled()) return; // paper is fine
    const s = this.client.status();
    if (!s.connected || !s.authenticated || s.accountStatus !== "active") {
      throw new Error("TopstepX is not connected/authenticated.");
    }
  }

  // --- SMS: outbound test + inbound command handling --------------------
  async sendTestSms() {
    const r = await sendSms(this.config, "Avrrio Trade AI test alert successful.");
    await this.audit.log("sms.test_sent", "operator", { ok: r.ok, info: r.info });
    return r;
  }

  /** Send a free-text SMS to the alert number (used for the daily summary). */
  async notifyText(text: string, type = "sms.notify"): Promise<void> {
    if (!this.config.notifications.sms.enabled) return;
    const r = await sendSms(this.config, text);
    await this.audit.log(type, "system", { ok: r.ok, info: r.info });
  }

  /**
   * Broadcast a free-text message to the operator's alert channels. Telegram is
   * primary; SMS is sent too when enabled. Used for scheduled day reports.
   */
  async broadcast(text: string, type = "report"): Promise<void> {
    if (this.telegram.enabled) {
      const r = await this.telegram.sendText(text);
      await this.audit.log(`${type}.telegram`, "system", { ok: r.ok, info: r.info });
    }
    if (this.config.notifications.sms.enabled) {
      const r = await sendSms(this.config, text);
      await this.audit.log(`${type}.sms`, "system", { ok: r.ok, info: r.info });
    }
  }

  /**
   * Build + send a scheduled day report (morning / midday / closing) to the
   * operator's channels. Read-only — never places or modifies trades.
   */
  async sendScheduledReport(
    slot: "morning" | "midday" | "closing",
    scans: number,
  ): Promise<string> {
    const text =
      slot === "closing"
        ? this.dailySummaryText(scans)
        : await this.buildReport(slot, scans);
    await this.broadcast(text, `report.${slot}`);
    return text;
  }

  /** Morning/midday report: account snapshot + today's best opportunities. */
  private async buildReport(
    slot: "morning" | "midday",
    scans: number,
  ): Promise<string> {
    const header =
      slot === "morning" ? "☀️ AVRRIO MORNING REPORT" : "🌤️ AVRRIO MIDDAY REPORT";
    let account: AccountSummary | null = null;
    try {
      account = await this.getAccount();
    } catch {
      /* report still useful without the account snapshot */
    }
    const top = (await this.scan({ limit: 12 }))
      .filter((r) => r.tradable && (r.direction === "bullish" || r.direction === "bearish"))
      .slice(0, 3);
    const lines = [header, `Mode: ${this.getTradingMode()} · Trading: ${this.isLiveTradingEnabled() ? "LIVE" : "paper"}`];
    if (account) {
      lines.push(
        `Account: ${account.name} · BP $${account.balance.toLocaleString()} · Day P&L ${account.dayPnl >= 0 ? "+" : ""}$${account.dayPnl.toLocaleString()}`,
      );
    }
    lines.push(`Kill switch: ${this.killSwitch.isEngaged() ? "ENGAGED" : "clear"}`);
    if (slot === "midday") lines.push(`Scans today: ${scans}`);
    lines.push("", top.length ? "Top opportunities:" : "No tradable setups right now.");
    for (const o of top) {
      lines.push(
        `• ${o.symbol} ${o.direction === "bullish" ? "LONG" : "SHORT"} — score ${o.score}/100`,
      );
    }
    return lines.join("\n");
  }

  /** Build the end-of-day report from today's recommendations + journal. */
  dailySummaryText(scans: number): string {
    const today = new Date().toISOString().slice(0, 10);
    const todays = this.recommendations
      .list()
      .filter((r) => r.createdAt.slice(0, 10) === today);
    const signals = todays.length;
    const approved = todays.filter(
      (r) => r.status === "executed" || r.status === "approved",
    ).length;
    const rejected = todays.filter((r) => r.status === "rejected").length;
    const stats = this.journal.stats();
    const closed = this.journal
      .list()
      .filter((e) => e.status === "closed" && (e.realizedPnl ?? 0) !== 0);
    const wins = closed.filter((e) => (e.realizedPnl ?? 0) > 0).length;
    const winRate = closed.length ? (wins / closed.length) * 100 : 0;
    return [
      "📊 AVRRIO DAILY REPORT",
      `Scans: ${scans}`,
      `Signals: ${signals}`,
      `Approved: ${approved}`,
      `Rejected: ${rejected}`,
      `Win Rate: ${winRate.toFixed(1)}%`,
      `PnL: ${stats.realizedPnl >= 0 ? "+" : ""}$${stats.realizedPnl.toFixed(0)}`,
    ].join("\n");
  }

  /** Optional alert when a high-confidence scanner opportunity is found. */
  async alertOpportunity(o: {
    symbol: string;
    direction: string;
    score: number;
    confidence: number;
  }): Promise<void> {
    if (!this.config.notifications.sms.enabled) return;
    if (o.score < this.config.notifications.opportunityAlertScore) return;
    const name = findSymbol(o.symbol)?.name ?? o.symbol;
    const r = await sendSms(this.config, formatOpportunitySms({ ...o, name }));
    await this.audit.log("sms.opportunity_sent", "system", {
      symbol: o.symbol,
      score: o.score,
      ok: r.ok,
    });
  }

  /**
   * Handle an inbound SMS reply. Authorizes by phone number, parses the command,
   * applies it through the same safety gates as the dashboard, audits it, and
   * returns the confirmation text to send back.
   */
  async handleInboundSms(fromNumber: string, body: string): Promise<string> {
    const authorized = samePhone(fromNumber, this.config.notifications.sms.toNumber);
    if (!authorized) {
      await this.audit.log("sms.unauthorized", fromNumber, { body });
      return "⚠️ Unauthorized number. Command rejected.";
    }
    const cmd = parseSmsCommand(body);
    await this.audit.log("sms.command", fromNumber, { cmd });
    return this.applySmsCommand(cmd);
  }

  private async applySmsCommand(cmd: SmsCommand): Promise<string> {
    switch (cmd.type) {
      case "stopall":
        await this.engageKill("SMS STOPALL", "phone");
        return "🛑 Emergency Stop activated. No trades can execute.";
      case "status":
        return this.smsStatusText();
      case "pending":
        return this.smsPendingText();
      case "approve":
        return this.approveBySms(cmd.ref);
      case "reject":
        return this.rejectBySms(cmd.ref);
      default:
        return "Sorry, I didn't understand. Reply YES <id>, NO <id>, STOPALL, STATUS, or PENDING.";
    }
  }

  private telegramDetails(ref: string): string {
    const rec = this.recommendations.findByRef(ref);
    if (!rec) return `⚠️ Trade ${ref} not found.`;
    const rr = rec.riskAmount > 0 ? Math.abs(rec.target - rec.entry) / Math.abs(rec.entry - rec.stopLoss) : 0;
    const liveMode = this.settings.isLiveTradingEnabled() ? "LIVE" : "paper/simulated";
    return [
      `📋 Trade ${rec.ref} details`,
      `${rec.symbol} ${rec.side.toUpperCase()} ×${rec.size}`,
      `Entry ${rec.entry} · Stop ${rec.stopLoss} · Target ${rec.target}`,
      `Risk $${rec.riskAmount.toFixed(0)} · R/R ${Number.isFinite(rr) ? rr.toFixed(1) : "n/a"}`,
      `Status ${rec.status} · Mode ${liveMode}`,
      `Risk checks ${rec.riskApproved ? "passed" : "failed"}`,
      `Live trading remains ${this.settings.isLiveTradingEnabled() ? "enabled" : "locked/off"}.`,
    ].join("\n");
  }

  /**
   * Re-evaluates live risk limits for a recommendation at approval time and
   * returns a human reason if it is locked out (daily-loss budget, position
   * size, per-trade risk, or max trades/day), else null. Read-only.
   */
  private async riskLockoutReason(rec: Recommendation): Promise<string | null> {
    const account = await this.getAccount();
    const context: RiskContext = {
      symbolTradable: isTradable(rec.symbol),
      killSwitchEngaged: this.killSwitch.isEngaged(),
      tradesToday: this.recommendations.executedToday(),
      safety: {
        maxPositionSize: this.config.safety.maxPositionSize,
        maxTradesPerDay: this.config.safety.maxTradesPerDay,
        maxRiskPerTrade: this.config.safety.maxRiskPerTrade,
        maxDailyLoss: this.config.safety.dailyMaxLoss,
      },
    };
    const assessment = this.risk.assess(rec, account, context);
    const lockoutRules = new Set([
      "daily-loss-budget",
      "max-position-size",
      "engine-max-position-size",
      "max-risk-per-trade",
      "max-trades-per-day",
    ]);
    const hit = assessment.violations.filter((v) => lockoutRules.has(v.rule));
    return hit.length ? hit.map((v) => v.message).join("; ") : null;
  }

  /** Sends a Telegram (and SMS, if on) warning that a trade was blocked. */
  private async warnLockout(
    rec: Recommendation,
    reason: string,
    kind: string,
  ): Promise<void> {
    const text = `⚠️ AVRRIO SAFETY BLOCK\nTrade ${rec.ref} (${rec.symbol} ${rec.side.toUpperCase()}) was blocked.\nReason: ${reason}.\nNo order was placed.`;
    await this.broadcast(text, "safety.lockout");
    await this.audit.log("safety.lockout_warned", "system", {
      ref: rec.ref,
      kind,
      reason,
    });
  }

  private async approveBySms(ref: string): Promise<string> {
    const rec = this.recommendations.findByRef(ref);
    if (!rec) return `⚠️ Trade ${ref} not found.`;
    if (this.settings.getTradingMode() === "advisor") {
      await this.audit.log("approve.advisor_only", "phone", { ref });
      return `ℹ️ Advisor mode: Avrrio does not place orders. Enter ${ref} manually in TopstepX if you want it.`;
    }
    if (this.killSwitch.isEngaged()) {
      await this.warnLockout(rec, "Emergency Stop is engaged", "kill-switch");
      return `🛑 Emergency Stop active. Trade ${ref} cannot execute.`;
    }
    if (rec.status !== "pending" && rec.status !== "armed") {
      return `⚠️ Trade ${ref} is ${rec.status} and cannot be approved.`;
    }
    if (rec.expiresAt && Date.now() > new Date(rec.expiresAt).getTime()) {
      rec.status = "expired";
      await this.recommendations.update(rec);
      return `⚠️ Trade ${ref} expired. Approval blocked.`;
    }
    // Re-check live risk limits at approval time: daily-loss lockout, position
    // size, per-trade risk, max trades. Block + warn if any is hit.
    const lockout = await this.riskLockoutReason(rec);
    if (lockout) {
      await this.warnLockout(rec, lockout, "risk-limit");
      return `⚠️ Trade ${ref} blocked by risk limits: ${lockout}.`;
    }
    // Block if the market has moved too far from entry.
    const quote = await this.client.getQuote(rec.symbol);
    const tol = this.config.queue.entryTriggerTolerancePct;
    if (rec.entry > 0 && Math.abs(quote.last - rec.entry) / rec.entry > tol * 50) {
      return `⚠️ Trade ${ref} blocked: price moved too far from entry ${rec.entry} (now ${quote.last}).`;
    }
    // TopstepX readiness gate.
    if (this.settings.isLiveTradingEnabled()) {
      const s = this.client.status();
      if (!s.connected || !s.authenticated || s.accountStatus !== "active") {
        await this.audit.log("sms.approve_blocked", "phone", {
          ref,
          reason: "topstepx not connected",
        });
        return `⚠️ Trade ${ref} approved, but execution blocked because TopstepX is not connected.`;
      }
    }
    try {
      const result = await this.approve(rec.id, "phone", "immediate");
      return `✅ Trade ${ref} approved. ${result.result?.paper ? "Paper fill" : "Order submitted"} (${result.result?.orderId ?? "pending"}).`;
    } catch (err) {
      return `⚠️ Trade ${ref} could not execute: ${err instanceof Error ? err.message : "error"}`;
    }
  }

  private async rejectBySms(ref: string): Promise<string> {
    const rec = this.recommendations.findByRef(ref);
    if (!rec) return `⚠️ Trade ${ref} not found.`;
    await this.executor.reject(rec, "phone", "rejected via SMS");
    return `❌ Trade ${ref} rejected.`;
  }

  private smsStatusText(): string {
    const t = this.client.status();
    const ks = this.killSwitch.isEngaged() ? "ENGAGED" : "clear";
    return [
      `Avrrio status: ${t.offline ? "demo" : "live"} data`,
      `TopstepX: ${t.connected ? "connected" : "not connected"} (${t.accountStatus})`,
      `Day P&L $${t.dailyPnL} · Pending ${this.recommendations.pending().length}`,
      `Kill switch: ${ks}`,
    ].join("\n");
  }

  private smsPendingText(): string {
    const pending = this.recommendations.pending().concat(this.recommendations.armed());
    if (pending.length === 0) return "No pending trades.";
    return pending
      .slice(0, 5)
      .map((r) => `${r.ref}: ${r.symbol} ${r.side.toUpperCase()} @ ${r.entry} (${r.status})`)
      .join("\n");
  }

  closePaperTrade(id: string, exit: number, symbol: string) {
    return this.journal.close(id, exit, pointValue(symbol));
  }

  /** Quick one-off evaluation without storing a recommendation (Phase 1 CLI). */
  async evaluate(idea: TradeIdea) {
    const account = await this.getAccount();
    const snapshot = await this.snapshot(idea.symbol);
    const assessment = this.risk.assess(idea, account);
    const analysis = await this.claude.analyze(snapshot, account);
    return { assessment, analysis, account };
  }
}

export type { Recommendation, Side, TopstepStatus };
