import Anthropic from "@anthropic-ai/sdk";
import type { AvrrioConfig } from "../config.js";
import type { MarketSnapshot } from "../market/marketData.js";
import type { AccountSummary, ClaudeAnalysis } from "../types.js";

/**
 * Claude-backed analysis service.
 *
 * Claude's job here is analyst + risk manager, NOT gambler. The prompt steers it
 * toward conservative, rules-aware recommendations and a structured response.
 * When no API key is configured, a deterministic offline stub is returned so the
 * rest of the engine keeps working.
 */
export class ClaudeAnalysisService {
  private readonly client: Anthropic | null;

  constructor(private readonly config: AvrrioConfig) {
    this.client = config.ai.anthropicApiKey
      ? new Anthropic({ apiKey: config.ai.anthropicApiKey })
      : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  async analyze(
    snapshot: MarketSnapshot,
    account: AccountSummary,
  ): Promise<ClaudeAnalysis> {
    if (!this.client) return offlineAnalysis(snapshot);

    const response = await this.client.messages.create({
      model: this.config.ai.claudeModel,
      max_tokens: 1024,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildPrompt(snapshot, account),
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return parseAnalysis(text, snapshot);
  }

  /**
   * Conversational, advisory-only answer to a free-form question with the
   * supplied (secret-free) context. NEVER places, approves, or modifies trades.
   */
  async ask(question: string, context: string): Promise<string> {
    if (!this.client) {
      return "Claude is offline (no ANTHROPIC_API_KEY set). I can still run /scan_now, /status, and route /approve · /reject — set the key for conversational answers.";
    }
    try {
      const response = await this.client.messages.create({
        model: this.config.ai.claudeModel,
        max_tokens: 700,
        system: ASK_SYSTEM_PROMPT,
        messages: [
          { role: "user", content: `${context}\n\nQuestion: ${question}` },
        ],
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return text || "(no answer)";
    } catch (err) {
      return `Could not reach Claude: ${err instanceof Error ? err.message : "error"}`;
    }
  }
}

const ASK_SYSTEM_PROMPT = `You are Avrrio Trade AI's advisory assistant, answering the operator over Telegram.
Answer conversationally and concisely (a few sentences) using ONLY the provided context.
You are ADVISORY ONLY: you cannot place, approve, modify, or cancel trades. If asked to trade,
explain that the operator must approve via the dashboard or the Telegram approve buttons.
Never reveal API keys, tokens, passwords, or other secrets.`;

const SYSTEM_PROMPT = `You are Avrrio Trade AI, a disciplined futures trading analyst and risk manager.
Your priority is capital preservation and rule compliance, not maximizing trade frequency.
You are advising a trader on a funded/evaluation account with strict daily-loss and drawdown rules.

Rules for your response:
- Recommend "no-trade" whenever the setup is unclear, reward/risk is poor, or rules would be threatened.
- Always include a stop loss and target when you recommend a trade.
- Be explicit and concise.

Respond with ONLY a JSON object, no prose, in this exact shape:
{"recommendation": "long" | "short" | "no-trade", "confidence": 0.0-1.0, "stopLoss": number | null, "target": number | null, "summary": "one or two sentences"}`;

function buildPrompt(snapshot: MarketSnapshot, account: AccountSummary): string {
  const { symbol, quote, structure } = snapshot;
  return [
    `Symbol: ${symbol}`,
    `Last: ${quote.last}  Bid: ${quote.bid}  Ask: ${quote.ask}`,
    `Trend: ${structure.trend}  SMA: ${structure.sma.toFixed(2)}  Recent high: ${structure.recentHigh}  Recent low: ${structure.recentLow}`,
    "",
    "Account context:",
    `Balance: $${account.balance}  Day P&L: $${account.dayPnl}`,
    `Max daily loss: $${account.rules.maxDailyLoss}  Max position size: ${account.rules.maxPositionSize}`,
    "",
    "Given the above, provide your analysis as JSON.",
  ].join("\n");
}

function parseAnalysis(text: string, snapshot: MarketSnapshot): ClaudeAnalysis {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no json");
    const parsed = JSON.parse(match[0]) as Partial<ClaudeAnalysis> & {
      stopLoss?: number | null;
      target?: number | null;
    };
    const rec = parsed.recommendation;
    return {
      recommendation:
        rec === "long" || rec === "short" || rec === "no-trade"
          ? rec
          : "no-trade",
      confidence: clamp01(Number(parsed.confidence ?? 0)),
      stopLoss: parsed.stopLoss ?? undefined,
      target: parsed.target ?? undefined,
      summary: parsed.summary ?? "No summary provided.",
      fromModel: true,
    };
  } catch {
    // Model returned something unparseable — fail safe to no-trade.
    return {
      recommendation: "no-trade",
      confidence: 0,
      summary: `Could not parse model response; defaulting to no-trade. Raw: ${text.slice(0, 160)}`,
      fromModel: true,
    };
  }
}

function offlineAnalysis(snapshot: MarketSnapshot): ClaudeAnalysis {
  return {
    recommendation: "no-trade",
    confidence: 0,
    summary: `Offline mode (no ANTHROPIC_API_KEY). Trend is ${snapshot.structure.trend}; enable Claude for a real assessment.`,
    fromModel: false,
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
