import type { OrderType, Side } from "../types.js";

export type { OrderType };

export interface OrderSelectionInput {
  side: Side;
  entry: number;
}

export interface OrderSelectionResult {
  orderType: OrderType;
  /** Human-readable explanation of why this order type was chosen. */
  rationale: string;
}

/** Entry within this fraction of the last price counts as "at the market". */
export const AT_MARKET_TOLERANCE_PCT = 0.0015;

/**
 * Chooses the order type a professional desk would use for this setup:
 * - Entry beyond the current price in the trade's direction (a breakout
 *   level the market hasn't reached yet) -> stop order, so the entry only
 *   triggers once that level is actually confirmed.
 * - Entry behind the current price (a pullback/retracement) -> limit order,
 *   so the fill never happens at a worse price than the plan called for.
 * - Entry already at the current price -> market order, since there is
 *   nothing left to wait for.
 */
export function selectOrderType(
  input: OrderSelectionInput,
  lastPrice: number,
  tolerancePct = AT_MARKET_TOLERANCE_PCT,
): OrderSelectionResult {
  const { side, entry } = input;
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
    return {
      orderType: "limit",
      rationale:
        "No live price available — defaulting to a limit order at the planned entry so the fill never happens at a worse price.",
    };
  }

  const relDiff = Math.abs(entry - lastPrice) / lastPrice;
  if (relDiff <= tolerancePct) {
    return {
      orderType: "market",
      rationale: `Entry (${entry}) is already at the current market price (${lastPrice}) — a market order fills immediately at the confirmed level.`,
    };
  }

  const isBreakout = side === "long" ? entry > lastPrice : entry < lastPrice;
  if (isBreakout) {
    return {
      orderType: "stop_market",
      rationale: `Entry (${entry}) is ${side === "long" ? "above" : "below"} the current price (${lastPrice}) — this is a breakout level, so a stop order triggers the entry only once price actually confirms the move.`,
    };
  }

  return {
    orderType: "limit",
    rationale: `Entry (${entry}) is ${side === "long" ? "below" : "above"} the current price (${lastPrice}) — this is a pullback entry, so a limit order waits for price to retrace there instead of chasing it.`,
  };
}

export function orderTypeLabel(orderType: OrderType): string {
  switch (orderType) {
    case "limit":
      return "Limit";
    case "stop_market":
      return "Stop Market";
    case "market":
      return "Market";
  }
}
