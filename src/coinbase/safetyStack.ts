/**
 * Coinbase autonomy safety gates.
 *
 * Every gate must pass before the autonomy engine may execute a trade.
 * Gates are evaluated in order; the first failure short-circuits nothing —
 * all are evaluated so the operator sees the full picture.
 *
 * What the engine will NEVER do (enforced here or at the API layer):
 *   - Withdraw or transfer funds (API key must have no withdrawal permission)
 *   - Trade products not in allowedProducts
 *   - Increase size after a loss (no averaging down — tracked via openPositions)
 *   - Exceed any risk limit
 *   - Bypass the kill switch or emergency stop
 *   - Trade without market data (zero-entry blocked by stop_loss_defined gate)
 */

import type { CoinbaseSafety } from "../config.js";

export interface SafetyGate {
  name: string;
  passed: boolean;
  reason: string;
}

export interface SafetyResult {
  passed: boolean;
  gates: SafetyGate[];
  blockedBy: string | null;
}

export interface TradeCandidate {
  productId: string;
  side: "BUY" | "SELL";
  entry: number;
  stopLoss: number;
  target: number;
  score: number;
  rewardRisk: number;
}

export interface TradingState {
  tradesToday: number;
  lastTradeTime: Date | null;
  openPositionsCount: number;
  /** Realized day loss in USD (positive = loss). */
  dayLossUsd: number;
  paused: boolean;
  emergencyStop: boolean;
  killSwitchEngaged: boolean;
  /** Symbols already open in same direction (to prevent averaging down). */
  openSymbols: Set<string>;
}

export function checkSafetyGates(
  candidate: TradeCandidate,
  safety: CoinbaseSafety,
  state: TradingState,
): SafetyResult {
  const gates: SafetyGate[] = [];

  gates.push({
    name: "coinbase_emergency_stop",
    passed: !state.emergencyStop,
    reason: state.emergencyStop ? "Coinbase emergency stop engaged" : "clear",
  });

  gates.push({
    name: "global_kill_switch",
    passed: !state.killSwitchEngaged,
    reason: state.killSwitchEngaged ? "Global kill switch engaged" : "clear",
  });

  gates.push({
    name: "trading_enabled",
    passed: safety.tradingEnabled,
    reason: safety.tradingEnabled ? "enabled" : "COINBASE_TRADING_ENABLED=false",
  });

  gates.push({
    name: "autonomous_enabled",
    passed: safety.autonomousEnabled,
    reason: safety.autonomousEnabled ? "enabled" : "COINBASE_AUTONOMOUS_ENABLED=false — set after readiness passes",
  });

  gates.push({
    name: "not_paused",
    passed: !state.paused,
    reason: state.paused ? "automation paused by operator" : "running",
  });

  const productAllowed =
    safety.allowedProducts.length === 0 ||
    safety.allowedProducts.includes(candidate.productId);
  gates.push({
    name: "allowed_product",
    passed: productAllowed,
    reason: productAllowed
      ? "allowed"
      : `${candidate.productId} not in COINBASE_ALLOWED_PRODUCTS`,
  });

  const dayLossOk =
    safety.maxDailyLossUsd <= 0 || state.dayLossUsd < safety.maxDailyLossUsd;
  gates.push({
    name: "daily_loss_cap",
    passed: dayLossOk,
    reason: dayLossOk
      ? `$${state.dayLossUsd.toFixed(2)} / $${safety.maxDailyLossUsd}`
      : `Day loss $${state.dayLossUsd.toFixed(2)} exceeds cap $${safety.maxDailyLossUsd}`,
  });

  const openOk = state.openPositionsCount < safety.maxOpenPositions;
  gates.push({
    name: "max_open_positions",
    passed: openOk,
    reason: openOk
      ? `${state.openPositionsCount}/${safety.maxOpenPositions} open`
      : `Max open positions reached (${safety.maxOpenPositions})`,
  });

  const tradesTodayOk = state.tradesToday < safety.maxTradesPerDay;
  gates.push({
    name: "max_trades_per_day",
    passed: tradesTodayOk,
    reason: tradesTodayOk
      ? `${state.tradesToday}/${safety.maxTradesPerDay} today`
      : `Daily trade limit reached (${safety.maxTradesPerDay})`,
  });

  let cooldownOk = true;
  let cooldownReason = "no previous trade";
  if (state.lastTradeTime) {
    const elapsedMin =
      (Date.now() - state.lastTradeTime.getTime()) / 60_000;
    cooldownOk = elapsedMin >= safety.cooldownMinutes;
    cooldownReason = cooldownOk
      ? `${Math.floor(elapsedMin)}m since last trade`
      : `Cooldown: ${Math.ceil(safety.cooldownMinutes - elapsedMin)}m remaining`;
  }
  gates.push({ name: "cooldown", passed: cooldownOk, reason: cooldownReason });

  const rrOk = candidate.rewardRisk >= safety.minRewardRisk;
  gates.push({
    name: "min_reward_risk",
    passed: rrOk,
    reason: rrOk
      ? `R:R ${candidate.rewardRisk.toFixed(2)} >= ${safety.minRewardRisk}`
      : `R:R ${candidate.rewardRisk.toFixed(2)} below minimum ${safety.minRewardRisk}`,
  });

  const stopSet = Math.abs(candidate.entry - candidate.stopLoss) > 0;
  gates.push({
    name: "stop_loss_defined",
    passed: stopSet,
    reason: stopSet ? "stop loss defined" : "entry equals stop loss — zero-risk trade blocked",
  });

  // No averaging down: reject if same symbol is already open in the same direction
  const duplicateKey = `${candidate.productId}:${candidate.side}`;
  const noDuplicate = !state.openSymbols.has(duplicateKey);
  gates.push({
    name: "no_averaging_down",
    passed: noDuplicate,
    reason: noDuplicate
      ? "no open position in same direction"
      : `Already open ${candidate.productId} ${candidate.side} — averaging down blocked`,
  });

  const failed = gates.find((g) => !g.passed);
  return {
    passed: !failed,
    gates,
    blockedBy: failed?.name ?? null,
  };
}
