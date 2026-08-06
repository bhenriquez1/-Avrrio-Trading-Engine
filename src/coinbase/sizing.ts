/**
 * Dollar-risk-based position sizing for Coinbase crypto trades.
 *
 * Coin quantity = dollar risk / |entry - stopLoss|
 * Capped by maxPositionUsd and maxRiskPerTradeUsd from CoinbaseSafety config.
 */

export interface CryptoSizeInput {
  entry: number;
  stopLoss: number;
  riskDollars: number;
  maxPositionUsd: number;
  maxRiskPerTradeUsd: number;
  /** USD fee rate, e.g. 0.006 for 0.6%. */
  feeRate?: number;
}

export interface CryptoSizeResult {
  /** Coin quantity to buy/sell. */
  quantity: number;
  /** USD value of the position at entry. */
  positionValueUsd: number;
  /** Actual dollar risk (after capping). */
  riskDollars: number;
  /** Estimated round-trip fee in USD. */
  estimatedFeeUsd: number;
  /** Estimated slippage in USD (0.05% of position). */
  estimatedSlippageUsd: number;
  /** True if position was capped by maxPositionUsd or maxRiskPerTradeUsd. */
  capped: boolean;
}

export function sizeCryptoTrade(input: CryptoSizeInput): CryptoSizeResult {
  const {
    entry,
    stopLoss,
    maxPositionUsd,
    maxRiskPerTradeUsd,
    feeRate = 0.006,
  } = input;
  const stopDist = Math.abs(entry - stopLoss);
  if (stopDist === 0) {
    return {
      quantity: 0,
      positionValueUsd: 0,
      riskDollars: 0,
      estimatedFeeUsd: 0,
      estimatedSlippageUsd: 0,
      capped: false,
    };
  }

  const requestedRisk = Math.min(input.riskDollars, maxRiskPerTradeUsd);
  let quantity = requestedRisk / stopDist;
  let positionValue = quantity * entry;
  let capped = input.riskDollars > maxRiskPerTradeUsd;

  if (positionValue > maxPositionUsd) {
    quantity = maxPositionUsd / entry;
    positionValue = maxPositionUsd;
    capped = true;
  }

  const actualRisk = quantity * stopDist;
  const fee = positionValue * feeRate * 2; // round-trip
  const slippage = positionValue * 0.0005;

  return {
    quantity,
    positionValueUsd: positionValue,
    riskDollars: actualRisk,
    estimatedFeeUsd: fee,
    estimatedSlippageUsd: slippage,
    capped,
  };
}

/** Formats a quantity to a human-readable string (4 decimals for price, 6 for small coins). */
export function formatCryptoQty(quantity: number, priceUsd: number): string {
  if (priceUsd > 1000) return quantity.toFixed(6);
  if (priceUsd > 1) return quantity.toFixed(4);
  return quantity.toFixed(2);
}

/** Estimate slippage as a fraction of notional (0.05% base, scales with size). */
export function estimateSlippagePct(positionValueUsd: number): number {
  if (positionValueUsd < 1000) return 0.0005;
  if (positionValueUsd < 10000) return 0.001;
  return 0.002;
}
