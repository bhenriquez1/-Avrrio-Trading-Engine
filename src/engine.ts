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
import { TelegramNotifier } from "./notifications/telegramNotifier.js";
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
} from "./types.js";

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
  readonly settings: RuntimeSettings;
  readonly scheduler: Scheduler;
  readonly auth: Auth;

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
    // SMS is handled by the dedicated, fully-formatted signal path (sendSignalSms),
    // so it is not registered here to avoid duplicate texts.
    this.notifications = new NotificationManager(config, [
      new TelegramNotifier(config),
      new EmailNotifier(config),
    ]);
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
    return configWarnings(this.config);
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
      },
    };

    const assessment = this.risk.assess(input, account, context);
    const { score: avrrioScore } = scoreSnapshot(snapshot, news.blocked);

    const consensusAgrees =
      consensus.recommendation === input.side &&
      consensus.agreement >= 2 &&
      consensus.confidence >= this.config.ai.confidenceThreshold;

    const autoEligible =
      this.config.execution.semiAutonomousEnabled &&
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
      if (this.notifications.enabled) {
        const results = await this.notifications.notify(rec);
        await this.audit.log("notification.sent", "system", {
          recommendationId: rec.id,
          channels: results.map((r) => `${r.channel}:${r.ok ? "ok" : r.info}`),
        });
      }
      // SMS signal with reply-to-approve instructions.
      await this.sendSignalSms(rec);
    }

    return rec;
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
  topstepxAuthTest(): Promise<AuthTestResult> {
    return this.client.authTest();
  }

  // --- runtime trading mode (paper/live) toggle -------------------------
  isLiveTradingEnabled(): boolean {
    return this.settings.isLiveTradingEnabled();
  }
  async setLiveTrading(enabled: boolean, actor: string): Promise<void> {
    await this.settings.setLiveTrading(enabled);
    await this.audit.log("settings.live_trading", actor, { enabled });
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

  private async approveBySms(ref: string): Promise<string> {
    const rec = this.recommendations.findByRef(ref);
    if (!rec) return `⚠️ Trade ${ref} not found.`;
    if (this.killSwitch.isEngaged()) {
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
