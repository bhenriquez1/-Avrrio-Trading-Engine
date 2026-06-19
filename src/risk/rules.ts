import type { Side } from "../types.js";

/**
 * Per-symbol point (tick) values used to convert price distance into dollars.
 * Extend this map as you trade more products. Values are USD per 1.0 of price
 * movement per contract (CME E-mini / Micro futures).
 */
export const POINT_VALUES: Record<string, number> = {
  ES: 50, // E-mini S&P 500
  MES: 5, // Micro E-mini S&P 500
  NQ: 20, // E-mini Nasdaq 100
  MNQ: 2, // Micro E-mini Nasdaq 100
  YM: 5, // E-mini Dow
  MYM: 0.5, // Micro E-mini Dow
  RTY: 50, // E-mini Russell 2000
  M2K: 5, // Micro E-mini Russell 2000
  CL: 1000, // Crude Oil ($ per $1.00 move)
  MCL: 100, // Micro Crude Oil
  GC: 100, // Gold ($ per $1.00 move)
  MGC: 10, // Micro Gold
};

/** Best-effort lookup; defaults to 1 so unknown symbols still compute a number. */
export function pointValue(symbol: string): number {
  const key = symbol.toUpperCase().replace(/[^A-Z]/g, "");
  for (const [code, value] of Object.entries(POINT_VALUES)) {
    if (key.startsWith(code)) return value;
  }
  return 1;
}

/**
 * Engine-level guardrails layered on top of the account's own Topstep rules.
 * These encode the behavioural discipline the project is really about:
 * preventing oversizing, bad reward/risk, and stop-less trades.
 */
export interface EngineRiskPolicy {
  /** Reject trades whose reward/risk is below this. */
  minRewardRiskRatio: number;
  /** Reject trades risking more than this fraction of the daily-loss budget. */
  maxRiskFractionOfDailyLoss: number;
  /** Require a stop loss on every idea. */
  requireStopLoss: boolean;
}

export const DEFAULT_POLICY: EngineRiskPolicy = {
  minRewardRiskRatio: 1.5,
  maxRiskFractionOfDailyLoss: 0.5,
  requireStopLoss: true,
};

/** Validates that the stop sits on the correct side of the entry. */
export function stopIsValid(side: Side, entry: number, stop: number): boolean {
  return side === "long" ? stop < entry : stop > entry;
}

/** Validates that the target sits on the correct side of the entry. */
export function targetIsValid(
  side: Side,
  entry: number,
  target: number,
): boolean {
  return side === "long" ? target > entry : target < entry;
}
