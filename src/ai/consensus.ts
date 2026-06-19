import Anthropic from "@anthropic-ai/sdk";
import type { AvrrioConfig } from "../config.js";
import type { MarketSnapshot } from "../market/marketData.js";
import type { AccountSummary, Side } from "../types.js";
import {
  ANALYSIS_SYSTEM_PROMPT,
  abstain,
  buildAnalysisPrompt,
  openAICompatibleAnalyze,
  parseOpinion,
  type AnalysisProvider,
  type Opinion,
  type ProviderOpinion,
} from "./providers.js";

export interface ConsensusResult {
  /** The agreed direction, or "no-trade" when there is no qualifying majority. */
  recommendation: Side | "no-trade";
  /** Average confidence among the agreeing providers. */
  confidence: number;
  /** Number of providers that voted for the winning direction. */
  agreement: number;
  /** Number of providers that produced a usable (non-abstain) opinion. */
  available: number;
  opinions: ProviderOpinion[];
}

class ClaudeProvider implements AnalysisProvider {
  readonly name = "claude";
  private readonly client: Anthropic | null;

  constructor(private readonly config: AvrrioConfig) {
    this.client = config.ai.anthropicApiKey
      ? new Anthropic({ apiKey: config.ai.anthropicApiKey })
      : null;
  }

  get available(): boolean {
    return this.client !== null;
  }

  async analyze(
    snapshot: MarketSnapshot,
    account: AccountSummary,
  ): Promise<ProviderOpinion> {
    if (!this.client) return abstain(this.name, "Not configured (no API key).");
    try {
      const res = await this.client.messages.create({
        model: this.config.ai.claudeModel,
        max_tokens: 512,
        thinking: { type: "adaptive" },
        system: ANALYSIS_SYSTEM_PROMPT,
        messages: [
          { role: "user", content: buildAnalysisPrompt(snapshot, account) },
        ],
      });
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      return parseOpinion(this.name, text);
    } catch (err) {
      return abstain(
        this.name,
        `Request failed: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }
}

class OpenAIProvider implements AnalysisProvider {
  readonly name = "openai";
  constructor(private readonly config: AvrrioConfig) {}
  get available(): boolean {
    return this.config.ai.openaiApiKey.length > 0;
  }
  analyze(snapshot: MarketSnapshot, account: AccountSummary) {
    return openAICompatibleAnalyze({
      provider: this.name,
      baseUrl: "https://api.openai.com/v1",
      apiKey: this.config.ai.openaiApiKey,
      model: this.config.ai.openaiModel,
      snapshot,
      account,
    });
  }
}

class TradeGptProvider implements AnalysisProvider {
  readonly name = "tradegpt";
  constructor(private readonly config: AvrrioConfig) {}
  get available(): boolean {
    return (
      this.config.ai.tradegptApiKey.length > 0 &&
      this.config.ai.tradegptBaseUrl.length > 0
    );
  }
  analyze(snapshot: MarketSnapshot, account: AccountSummary) {
    return openAICompatibleAnalyze({
      provider: this.name,
      baseUrl: this.config.ai.tradegptBaseUrl,
      apiKey: this.config.ai.tradegptApiKey,
      model: this.config.ai.tradegptModel,
      snapshot,
      account,
    });
  }
}

/**
 * Consensus engine: asks all configured providers and only returns a tradeable
 * direction when at least `minAgreement` (default 2) agree on it. Disagreement
 * or insufficient providers yields "no-trade".
 */
export class ConsensusEngine {
  private readonly providers: AnalysisProvider[];

  constructor(
    config: AvrrioConfig,
    private readonly minAgreement = 2,
  ) {
    this.providers = [
      new ClaudeProvider(config),
      new OpenAIProvider(config),
      new TradeGptProvider(config),
    ];
  }

  /** Names of providers that are configured and will be queried. */
  availableProviders(): string[] {
    return this.providers.filter((p) => p.available).map((p) => p.name);
  }

  async evaluate(
    snapshot: MarketSnapshot,
    account: AccountSummary,
  ): Promise<ConsensusResult> {
    const opinions = await Promise.all(
      this.providers.map((p) => p.analyze(snapshot, account)),
    );
    const usable = opinions.filter(
      (o) => o.available && o.recommendation !== "abstain",
    );

    const votes = (dir: Side) =>
      usable.filter((o) => o.recommendation === dir);
    const longs = votes("long");
    const shorts = votes("short");

    let recommendation: Side | "no-trade" = "no-trade";
    let agreeing: ProviderOpinion[] = [];
    if (longs.length >= this.minAgreement && longs.length > shorts.length) {
      recommendation = "long";
      agreeing = longs;
    } else if (
      shorts.length >= this.minAgreement &&
      shorts.length > longs.length
    ) {
      recommendation = "short";
      agreeing = shorts;
    }

    const confidence =
      agreeing.length > 0
        ? agreeing.reduce((s, o) => s + o.confidence, 0) / agreeing.length
        : 0;

    return {
      recommendation,
      confidence,
      agreement: agreeing.length,
      available: usable.length,
      opinions,
    };
  }
}

export type { Opinion, ProviderOpinion };
