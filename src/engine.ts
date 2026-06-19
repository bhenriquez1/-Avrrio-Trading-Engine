import { ClaudeAnalysisService } from "./ai/claudeAnalysis.js";
import { loadConfig, configWarnings, type AvrrioConfig } from "./config.js";
import { MarketDataReader, type MarketSnapshot } from "./market/marketData.js";
import { RiskManager } from "./risk/riskManager.js";
import { pointValue } from "./risk/rules.js";
import { TradeJournal } from "./journal/tradeJournal.js";
import { TopstepClient } from "./topstep/client.js";
import type {
  AccountSummary,
  ClaudeAnalysis,
  RiskAssessment,
  TradeIdea,
} from "./types.js";

/**
 * Composition root. Wires the read-only client, market reader, risk manager,
 * journal, and Claude analysis into one façade the CLI and dashboard share.
 */
export class AvrrioEngine {
  readonly config: AvrrioConfig;
  readonly client: TopstepClient;
  readonly market: MarketDataReader;
  readonly risk: RiskManager;
  readonly journal: TradeJournal;
  readonly claude: ClaudeAnalysisService;

  constructor(config = loadConfig()) {
    this.config = config;
    this.client = new TopstepClient(config);
    this.market = new MarketDataReader(this.client);
    this.risk = new RiskManager();
    this.journal = new TradeJournal();
    this.claude = new ClaudeAnalysisService(config);
  }

  async init(): Promise<void> {
    await this.journal.load();
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
   * Full evaluation of a trade idea: risk check + (optional) Claude analysis,
   * then journal it with its approval state. Never places an order.
   */
  async evaluate(idea: TradeIdea): Promise<{
    assessment: RiskAssessment;
    analysis: ClaudeAnalysis;
    account: AccountSummary;
  }> {
    const account = await this.getAccount();
    const snapshot = await this.snapshot(idea.symbol);
    const assessment = this.risk.assess(idea, account);
    const analysis = await this.claude.analyze(snapshot, account);
    await this.journal.record(idea, assessment.approved);
    return { assessment, analysis, account };
  }

  closePaperTrade(id: string, exit: number, symbol: string) {
    return this.journal.close(id, exit, pointValue(symbol));
  }
}
