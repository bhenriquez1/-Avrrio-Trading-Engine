import { AuditLog } from "./audit/auditLog.js";
import { Auth } from "./auth/auth.js";
import { ClaudeAnalysisService } from "./ai/claudeAnalysis.js";
import { ConsensusEngine } from "./ai/consensus.js";
import { loadConfig, configWarnings, type AvrrioConfig } from "./config.js";
import { OrderExecutor } from "./execution/orderExecutor.js";
import {
  RecommendationStore,
  type Recommendation,
} from "./execution/recommendations.js";
import { MarketDataReader, type MarketSnapshot } from "./market/marketData.js";
import { NewsReader } from "./news/newsReader.js";
import { RiskManager, type RiskContext } from "./risk/riskManager.js";
import { pointValue } from "./risk/rules.js";
import { KillSwitch } from "./safety/killSwitch.js";
import { findSetup, withinAllowedHours } from "./setups/index.js";
import { TradeJournal } from "./journal/tradeJournal.js";
import { TopstepClient } from "./topstep/client.js";
import type { AccountSummary, Side, TradeIdea } from "./types.js";

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
  readonly audit: AuditLog;
  readonly killSwitch: KillSwitch;
  readonly recommendations: RecommendationStore;
  readonly executor: OrderExecutor;
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
    this.killSwitch = new KillSwitch(config, this.audit);
    this.recommendations = new RecommendationStore();
    this.executor = new OrderExecutor(
      config,
      this.client,
      this.killSwitch,
      this.recommendations,
      this.audit,
    );
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
      await this.executor.execute(rec, "system");
    }

    return rec;
  }

  approve(id: string, actor: string) {
    const rec = this.recommendations.get(id);
    if (!rec) throw new Error(`Recommendation ${id} not found.`);
    return this.executor.execute(rec, actor);
  }

  async reject(id: string, actor: string, reason = ""): Promise<void> {
    const rec = this.recommendations.get(id);
    if (!rec) throw new Error(`Recommendation ${id} not found.`);
    await this.executor.reject(rec, actor, reason);
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
