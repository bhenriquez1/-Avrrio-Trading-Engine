import type { MarketSnapshot } from "../market/marketData.js";
import type { AccountSummary, Side } from "../types.js";

export type Opinion = Side | "no-trade" | "abstain";

export interface ProviderOpinion {
  provider: string;
  /** "abstain" when the provider is not configured/available. */
  recommendation: Opinion;
  confidence: number; // 0..1
  summary: string;
  available: boolean;
}

export interface AnalysisProvider {
  readonly name: string;
  readonly available: boolean;
  analyze(
    snapshot: MarketSnapshot,
    account: AccountSummary,
  ): Promise<ProviderOpinion>;
}

export const ANALYSIS_SYSTEM_PROMPT = `You are a disciplined futures trading analyst and risk manager.
Capital preservation and rule compliance come before trade frequency. The trader
uses a funded/evaluation account with strict daily-loss and drawdown rules.
Recommend "no-trade" whenever the setup is unclear or reward/risk is poor.
Respond with ONLY a JSON object, no prose:
{"recommendation": "long" | "short" | "no-trade", "confidence": 0.0-1.0, "summary": "one or two sentences"}`;

export function buildAnalysisPrompt(
  snapshot: MarketSnapshot,
  account: AccountSummary,
): string {
  const { symbol, quote, structure } = snapshot;
  return [
    `Symbol: ${symbol}`,
    `Last: ${quote.last}  Bid: ${quote.bid}  Ask: ${quote.ask}`,
    `Trend: ${structure.trend}  SMA: ${structure.sma.toFixed(2)}  High: ${structure.recentHigh}  Low: ${structure.recentLow}`,
    `Account balance: $${account.balance}  Day P&L: $${account.dayPnl}`,
    `Max daily loss: $${account.rules.maxDailyLoss}  Max position: ${account.rules.maxPositionSize}`,
    "Provide your analysis as JSON.",
  ].join("\n");
}

export function parseOpinion(
  provider: string,
  text: string,
): ProviderOpinion {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("no json");
    const parsed = JSON.parse(match[0]) as {
      recommendation?: string;
      confidence?: number;
      summary?: string;
    };
    const rec = parsed.recommendation;
    return {
      provider,
      recommendation:
        rec === "long" || rec === "short" || rec === "no-trade"
          ? rec
          : "no-trade",
      confidence: clamp01(Number(parsed.confidence ?? 0)),
      summary: parsed.summary ?? "",
      available: true,
    };
  } catch {
    return {
      provider,
      recommendation: "no-trade",
      confidence: 0,
      summary: `Unparseable response; defaulting to no-trade.`,
      available: true,
    };
  }
}

export function abstain(provider: string, reason: string): ProviderOpinion {
  return {
    provider,
    recommendation: "abstain",
    confidence: 0,
    summary: reason,
    available: false,
  };
}

/** Calls any OpenAI-compatible chat-completions endpoint. */
export async function openAICompatibleAnalyze(args: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  snapshot: MarketSnapshot;
  account: AccountSummary;
}): Promise<ProviderOpinion> {
  const { provider, baseUrl, apiKey, model, snapshot, account } = args;
  if (!apiKey) return abstain(provider, "Not configured (no API key).");
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
          { role: "user", content: buildAnalysisPrompt(snapshot, account) },
        ],
        temperature: 0,
      }),
    });
    if (!res.ok) {
      return abstain(provider, `HTTP ${res.status} from ${provider}.`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return parseOpinion(provider, text);
  } catch (err) {
    return abstain(
      provider,
      `Request failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
