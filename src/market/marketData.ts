import type { TopstepClient } from "../topstep/client.js";
import type { Bar, Quote } from "../types.js";

export interface MarketSnapshot {
  symbol: string;
  quote: Quote;
  bars: Bar[];
  /** Simple structure summary derived from the bars. */
  structure: MarketStructure;
}

export interface MarketStructure {
  trend: "up" | "down" | "sideways";
  recentHigh: number;
  recentLow: number;
  /** Simple moving average of bar closes. */
  sma: number;
}

/**
 * Reads market data through the (read-only) TopstepX client and derives a small
 * amount of structure that the risk manager and Claude analysis can use.
 */
export class MarketDataReader {
  constructor(private readonly client: TopstepClient) {}

  async snapshot(symbol: string, barCount = 50): Promise<MarketSnapshot> {
    const [quote, bars] = await Promise.all([
      this.client.getQuote(symbol),
      this.client.getBars(symbol, barCount),
    ]);
    return { symbol, quote, bars, structure: deriveStructure(bars) };
  }
}

export function deriveStructure(bars: Bar[]): MarketStructure {
  if (bars.length === 0) {
    return { trend: "sideways", recentHigh: 0, recentLow: 0, sma: 0 };
  }
  const closes = bars.map((b) => b.close);
  const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
  const recentHigh = Math.max(...bars.map((b) => b.high));
  const recentLow = Math.min(...bars.map((b) => b.low));

  const first = closes[0]!;
  const last = closes[closes.length - 1]!;
  const change = (last - first) / first;
  const trend: MarketStructure["trend"] =
    change > 0.0015 ? "up" : change < -0.0015 ? "down" : "sideways";

  return { trend, recentHigh, recentLow, sma };
}
