import type { Side } from "../types.js";
import type { MarketStructure } from "../market/marketData.js";

/**
 * The four post-entry signals a desk would give on an open position:
 * - hold         🟢 no trigger yet, risk plan unchanged.
 * - tighten_stop 🟡 position is in profit — remove initial risk.
 * - take_partial 🟠 position is well in profit — bank some size.
 * - exit         🔴 the thesis broke (trend reversed) or the plan played out.
 */
export type ManagementAction =
  | "hold"
  | "tighten_stop"
  | "take_partial"
  | "exit";

export interface ManagementInput {
  side: Side;
  entry: number;
  stopLoss: number;
  target: number;
  last: number;
  trend: MarketStructure["trend"];
}

export interface ManagementSignal {
  action: ManagementAction;
  /** Move multiple of initial risk (R), signed favorable-positive. */
  rMultiple: number;
  reason: string;
  /** Suggested new stop price, only set for "tighten_stop". */
  suggestedStop?: number;
}

/** R-multiple at which a profitable position's stop moves to breakeven. */
export const TIGHTEN_STOP_R = 1;
/** R-multiple at which part of the position should be banked. */
export const TAKE_PARTIAL_R = 2;

export function assessPosition(input: ManagementInput): ManagementSignal {
  const { side, entry, stopLoss, target, last, trend } = input;
  const riskPts = Math.abs(entry - stopLoss);
  const move = side === "long" ? last - entry : entry - last;
  const rMultiple = riskPts > 0 ? round2(move / riskPts) : 0;

  const trendAligned =
    trend === "sideways" ||
    (side === "long" && trend === "up") ||
    (side === "short" && trend === "down");

  if (!trendAligned) {
    return {
      action: "exit",
      rMultiple,
      reason:
        rMultiple >= 0
          ? `Trend has reversed against the position — lock in the open ${rMultiple}R gain before it gives it back.`
          : `Trend has reversed against the position and price is already behind entry (${rMultiple}R) — cut it before the loss grows.`,
    };
  }

  const beyondTarget = side === "long" ? last >= target : last <= target;
  if (beyondTarget) {
    return {
      action: "exit",
      rMultiple,
      reason: `Price reached the target (${target}) — the plan played out, take the exit.`,
    };
  }

  if (rMultiple >= TAKE_PARTIAL_R) {
    return {
      action: "take_partial",
      rMultiple,
      reason: `Position is up ${rMultiple}R with the trend still intact — bank part of the size and let the remainder run toward target.`,
    };
  }

  if (rMultiple >= TIGHTEN_STOP_R) {
    return {
      action: "tighten_stop",
      rMultiple,
      suggestedStop: entry,
      reason: `Position is up ${rMultiple}R — move the stop to breakeven (${entry}) to remove initial risk.`,
    };
  }

  return {
    action: "hold",
    rMultiple,
    reason: `No management trigger yet (${rMultiple}R) — trend still aligned, risk plan unchanged.`,
  };
}

export function managementEmoji(action: ManagementAction): string {
  switch (action) {
    case "hold":
      return "🟢";
    case "tighten_stop":
      return "🟡";
    case "take_partial":
      return "🟠";
    case "exit":
      return "🔴";
  }
}

export function managementLabel(action: ManagementAction): string {
  switch (action) {
    case "hold":
      return "Hold";
    case "tighten_stop":
      return "Tighten Stop";
    case "take_partial":
      return "Take Partial Profit";
    case "exit":
      return "Exit Position";
  }
}

export function managementText(
  ref: string,
  symbol: string,
  signal: ManagementSignal,
): string {
  return [
    `${managementEmoji(signal.action)} ${managementLabel(signal.action)} — ${symbol} (${ref})`,
    signal.reason,
  ].join("\n");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
