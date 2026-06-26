import type { ScoreComponents } from "../scanner/scanner.js";

/**
 * Trade Grade + Trade Quality Score (advisory only).
 *
 * Turns the raw scanner components into the "professional desk" presentation
 * (Confidence / Grade / Trend / Momentum / Volume / Structure / Risk) and a
 * separate weighted composite — the Trade Quality Score — used to decide
 * whether a setup is good enough to even alert the operator about. Avrrio
 * isn't looking for more trades; it's looking for better trades. This module
 * is pure and deterministic: it only scores/ranks, it never places orders.
 */

export const QUALITY_WEIGHTS = {
  trend: 0.25,
  structure: 0.2,
  momentum: 0.15,
  volume: 0.1,
  rewardRisk: 0.15,
  volatility: 0.05,
  consensus: 0.1,
} as const;

export type TradeGradeLetter = "A+" | "A" | "B" | "C" | "D";

export interface TradeGradeBreakdown {
  trend: number;
  structure: number;
  momentum: number;
  volume: number;
  rewardRisk: number;
  volatility: number;
  consensus: number;
}

export interface ConsensusInput {
  agreement: number;
  available: number;
}

export interface TradeGradeInput {
  components: ScoreComponents;
  rewardRiskRatio: number;
  riskApproved: boolean;
  consensus?: ConsensusInput | null;
}

export interface TradeGradeResult {
  /** 0..100 — same as qualityScore, surfaced as "Confidence %". */
  confidence: number;
  grade: TradeGradeLetter;
  /** 0..100 weighted Trade Quality Score composite. */
  qualityScore: number;
  /** True when the quality score clears the threshold AND risk checks passed. */
  qualifies: boolean;
  riskApproved: boolean;
  breakdown: TradeGradeBreakdown;
}

export function gradeFromScore(score: number): TradeGradeLetter {
  if (score >= 92) return "A+";
  if (score >= 84) return "A";
  if (score >= 72) return "B";
  if (score >= 60) return "C";
  return "D";
}

/** Default minimum Trade Quality Score for an alert to be sent. */
export const DEFAULT_QUALITY_THRESHOLD = 90;

export function computeTradeGrade(
  input: TradeGradeInput,
  qualityThreshold = DEFAULT_QUALITY_THRESHOLD,
): TradeGradeResult {
  const { components, rewardRiskRatio, riskApproved, consensus } = input;
  const breakdown: TradeGradeBreakdown = {
    trend: clamp(components.trend, 0, 100),
    structure: clamp(components.structure ?? 50, 0, 100),
    momentum: clamp(components.momentum, 0, 100),
    volume: clamp(components.volume, 0, 100),
    rewardRisk: rewardRiskScore(rewardRiskRatio),
    // The scanner's "risk" component already favors controlled (lower)
    // volatility, which is exactly what the Volatility weight wants.
    volatility: clamp(components.risk, 0, 100),
    consensus: consensusScore(consensus),
  };

  const qualityScore = Math.round(
    breakdown.trend * QUALITY_WEIGHTS.trend +
      breakdown.structure * QUALITY_WEIGHTS.structure +
      breakdown.momentum * QUALITY_WEIGHTS.momentum +
      breakdown.volume * QUALITY_WEIGHTS.volume +
      breakdown.rewardRisk * QUALITY_WEIGHTS.rewardRisk +
      breakdown.volatility * QUALITY_WEIGHTS.volatility +
      breakdown.consensus * QUALITY_WEIGHTS.consensus,
  );

  return {
    confidence: qualityScore,
    grade: gradeFromScore(qualityScore),
    qualityScore,
    qualifies: qualityScore >= qualityThreshold && riskApproved,
    riskApproved,
    breakdown,
  };
}

/** Human-readable "professional desk" card, e.g. for Telegram/dashboard. */
export function tradeGradeText(symbol: string, g: TradeGradeResult): string {
  const b = g.breakdown;
  return [
    symbol,
    `Confidence: ${g.confidence}%`,
    `Grade: ${g.grade}`,
    `Trend: ${describeTrend(b.trend)}`,
    `Momentum: ${Math.round(b.momentum)}`,
    `Volume: ${Math.round(b.volume)}`,
    `Structure: ${Math.round(b.structure)}`,
    `Risk: ${g.riskApproved ? "Approved" : "Blocked"}`,
  ].join("\n");
}

function describeTrend(trendScore: number): string {
  if (trendScore >= 80) return "Strong";
  if (trendScore >= 55) return "Moderate";
  if (trendScore >= 30) return "Weak";
  return "Flat / choppy";
}

function rewardRiskScore(rr: number): number {
  if (!Number.isFinite(rr) || rr <= 0) return 0;
  return clamp((rr / 3) * 100, 0, 100);
}

function consensusScore(consensus: ConsensusInput | null | undefined): number {
  if (!consensus || consensus.available <= 0) return 50; // neutral when AI unavailable
  return clamp((consensus.agreement / consensus.available) * 100, 0, 100);
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
