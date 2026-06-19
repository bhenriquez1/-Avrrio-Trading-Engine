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
import { SmsNotifier } from "./notifications/smsNotifier.js";
import { RiskManager, type RiskContext } from "./risk/riskManager.js";
import { pointValue } from "./risk/rules.js";
import { Scanner, type ScanOptions, type ScanResult } from "./scanner/scanner.js";
import { KillSwitch } from "./safety/killSwitch.js";
import { findSetup, withinAllowedHours } from "./setups/index.js";
import { isTradable } from "./symbols/registry.js";
import { TradeJournal } from "./journal/tradeJournal.js";
import { TopstepClient } from "./topstep/client.js";
import type { AccountSummary, OrderResult, Side, TradeIdea } from "./types.js";

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
  readonly auth: Auth;

  constructor(config = loadConfig()) {
    this.config = config;
    this.audit = new AuditLog();
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
      config,
      this.client,
      this.killSwitch,
      this.recommendations,
      this.audit,
    );
    this.notifications = new NotificationManager(config, [
      new TelegramNotifier(config),
      new EmailNotifier(config),
      new SmsNotifier(config),
    ]);
    this.auth = new Auth(config);
  }

  async init(): Promise<void> {
    await Promise.all([
      this.journal.load(),
      this.killSwitch.load(),
      this.recommendations.load(),
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
    } else if (rec.status === "pending" && this.notifications.enabled) {
      // Manual/pre-approved: alert the operator so they can approve from a phone.
      const results = await this.notifications.notify(rec);
      await this.audit.log("notification.sent", "system", {
        recommendationId: rec.id,
        channels: results.map((r) => `${r.channel}:${r.ok ? "ok" : r.info}`),
      });
    }

    return rec;
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

  engageKill(reason: string, actor: string) {
    return this.killSwitch.engage(reason, actor);
  }

  disengageKill(actor: string) {
    return this.killSwitch.disengage(actor);
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

export type { Recommendation, Side };
