import type { MarketDataReader, MarketSnapshot } from "../market/marketData.js";
import type { NewsReader } from "../news/newsReader.js";
import {
  SYMBOLS,
  type AssetClass,
  type SymbolInfo,
} from "../symbols/registry.js";

export interface ScoreComponents {
  trend: number; // 0..100, weight 30%
  volume: number; // 0..100, weight 20%
  news: number; // 0..100, weight 20%
  momentum: number; // 0..100, weight 15%
  risk: number; // 0..100, weight 15%
}

export const SCORE_WEIGHTS = {
  trend: 0.3,
  volume: 0.2,
  news: 0.2,
  momentum: 0.15,
  risk: 0.15,
} as const;

export type Direction = "bullish" | "bearish" | "reversal";

export interface ScanResult {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  tradable: boolean;
  /** Avrrio Score, 0..100. */
  score: number;
  direction: Direction;
  /** 0..1, derived from the score. */
  confidence: number;
  components: ScoreComponents;
  /** Beginner-friendly "why this is interesting" bullet points. */
  reasons: string[];
  newsBlocked: boolean;
}

export interface ScanOptions {
  classes?: AssetClass[];
  limit?: number;
}

/**
 * The opportunity scanner. It scores every symbol in the universe with the
 * Avrrio Score and ranks them, so a beginner sees "today's best setups and why"
 * instead of a blank symbol box.
 */
export class Scanner {
  constructor(
    private readonly market: MarketDataReader,
    private readonly news: NewsReader,
  ) {}

  async scan(options: ScanOptions = {}): Promise<ScanResult[]> {
    const classes = options.classes ?? ["futures", "stocks", "crypto"];
    const universe = SYMBOLS.filter((s) => classes.includes(s.assetClass));

    const results = await Promise.all(
      universe.map((info) => this.scoreSymbol(info)),
    );

    results.sort((a, b) => b.score - a.score);
    return options.limit ? results.slice(0, options.limit) : results;
  }

  private async scoreSymbol(info: SymbolInfo): Promise<ScanResult> {
    const snapshot = await this.market.snapshot(info.symbol);
    const news = await this.news.assess(info.symbol);
    const components = computeComponents(snapshot, news.blocked);
    const score = avrrioScore(components);
    const direction = directionOf(snapshot);
    const reasons = buildReasons(snapshot, news.blocked, components);

    return {
      symbol: info.symbol,
      name: info.name,
      assetClass: info.assetClass,
      tradable: info.tradable,
      score,
      direction,
      confidence: score / 100,
      components,
      reasons,
      newsBlocked: news.blocked,
    };
  }
}

/**
 * Suggest entry/stop/target for a scheduled-scanner signal, sized so reward/risk
 * is ~3:1. Stop distance is derived from recent volatility (average bar range).
 */
export function suggestLevels(
  snapshot: MarketSnapshot,
  side: "long" | "short",
): { entry: number; stopLoss: number; target: number } {
  const last = snapshot.quote.last || snapshot.structure.sma || 0;
  const ranges = snapshot.bars.map((b) => b.high - b.low);
  const atr = ranges.length
    ? ranges.reduce((a, b) => a + b, 0) / ranges.length
    : last * 0.001;
  const stopDist = Math.max(atr, last * 0.0005);
  return side === "long"
    ? { entry: last, stopLoss: last - stopDist, target: last + 3 * stopDist }
    : { entry: last, stopLoss: last + stopDist, target: last - 3 * stopDist };
}

/** Score a single snapshot (reuses already-fetched market data). */
export function scoreSnapshot(
  snapshot: MarketSnapshot,
  newsBlocked: boolean,
): { score: number; components: ScoreComponents } {
  const components = computeComponents(snapshot, newsBlocked);
  return { score: avrrioScore(components), components };
}

export function avrrioScore(c: ScoreComponents): number {
  const raw =
    c.trend * SCORE_WEIGHTS.trend +
    c.volume * SCORE_WEIGHTS.volume +
    c.news * SCORE_WEIGHTS.news +
    c.momentum * SCORE_WEIGHTS.momentum +
    c.risk * SCORE_WEIGHTS.risk;
  return Math.round(clamp(raw, 0, 100));
}

function computeComponents(
  snapshot: MarketSnapshot,
  newsBlocked: boolean,
): ScoreComponents {
  const { bars, structure, quote } = snapshot;
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const last = quote.last || closes[closes.length - 1] || 0;
  const first = closes[0] ?? last;

  // Trend: magnitude of directional move + clarity bonus.
  const change = first !== 0 ? (last - first) / first : 0;
  const trendBase = clamp(Math.abs(change) * 100 * 12, 0, 80);
  const trend = clamp(
    trendBase + (structure.trend !== "sideways" ? 20 : 0),
    0,
    100,
  );

  // Volume: recent vs average.
  const avgVol = mean(volumes) || 1;
  const recentVol = mean(volumes.slice(-5)) || avgVol;
  const volume = clamp((recentVol / avgVol) * 60, 0, 100);

  // News: blocked → low, otherwise clear.
  const news = newsBlocked ? 20 : 90;

  // Momentum: distance of price from its SMA, relative to price.
  const sma = structure.sma || last;
  const momentumRaw = sma !== 0 ? Math.abs((last - sma) / sma) : 0;
  const momentum = clamp(momentumRaw * 100 * 30, 0, 100);

  // Risk: lower volatility (tighter range) → higher (more controllable) score.
  const ranges = bars.map((b) => b.high - b.low);
  const atrPct = last !== 0 ? mean(ranges) / last : 0;
  const risk = clamp(100 - atrPct * 100 * 20, 0, 100);

  return { trend, volume, news, momentum, risk };
}

function directionOf(snapshot: MarketSnapshot): Direction {
  switch (snapshot.structure.trend) {
    case "up":
      return "bullish";
    case "down":
      return "bearish";
    default:
      return "reversal";
  }
}

function buildReasons(
  snapshot: MarketSnapshot,
  newsBlocked: boolean,
  c: ScoreComponents,
): string[] {
  const reasons: string[] = [];
  const { structure, quote } = snapshot;
  const last = quote.last;

  if (structure.trend === "up") reasons.push("Uptrend");
  else if (structure.trend === "down") reasons.push("Downtrend");
  else reasons.push("Range / possible reversal");

  if (last > structure.sma) reasons.push("Above 20-period average");
  else if (last < structure.sma) reasons.push("Below 20-period average");

  if (c.volume >= 70) reasons.push("Strong recent volume");
  reasons.push(newsBlocked ? "High-impact news nearby" : "No high-impact news");
  return reasons;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
