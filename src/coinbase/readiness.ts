/**
 * Coinbase Autonomy 12-step readiness checklist.
 *
 * All 12 steps must pass before COINBASE_AUTONOMOUS_ENABLED=true is safe.
 * Run GET /api/coinbase/autonomy/readiness to see the full report.
 */

import type { CoinbaseSafety } from "../config.js";
import type { CoinbaseClient } from "./client.js";

export interface ReadinessStep {
  step: number;
  name: string;
  passed: boolean;
  detail: string;
}

export interface CoinbaseReadinessReport {
  ready: boolean;
  passed: number;
  total: number;
  steps: ReadinessStep[];
  blockers: string[];
  recommendation: string;
}

export async function checkCoinbaseReadiness(
  safety: CoinbaseSafety,
  credentialsConfigured: boolean,
  client: CoinbaseClient,
  killSwitchEngaged: boolean,
): Promise<CoinbaseReadinessReport> {
  const steps: ReadinessStep[] = [];

  // 1 — Credentials
  steps.push({
    step: 1,
    name: "CDP API credentials configured",
    passed: credentialsConfigured,
    detail: credentialsConfigured
      ? "COINBASE_API_KEY_NAME and COINBASE_API_KEY_SECRET are set"
      : "Set COINBASE_API_KEY_NAME and COINBASE_API_KEY_SECRET (CDP portal → least-privilege, no withdrawals)",
  });

  // 2 — Live auth test
  let authOk = false;
  let authDetail = "Skipped — credentials not configured";
  if (credentialsConfigured && !client.isOffline) {
    try {
      const test = await client.authTest();
      authOk = test.ok;
      authDetail = test.message;
    } catch (err) {
      authDetail = err instanceof Error ? err.message : "Auth test threw an error";
    }
  }
  steps.push({ step: 2, name: "Coinbase API authentication passes", passed: authOk, detail: authDetail });

  // 3 — Trading enabled
  steps.push({
    step: 3,
    name: "COINBASE_TRADING_ENABLED=true",
    passed: safety.tradingEnabled,
    detail: safety.tradingEnabled
      ? "Live orders will be submitted to Coinbase"
      : "Set COINBASE_TRADING_ENABLED=true — currently in paper/read-only mode",
  });

  // 4 — Global kill switch clear
  steps.push({
    step: 4,
    name: "Global kill switch clear",
    passed: !killSwitchEngaged,
    detail: killSwitchEngaged
      ? "KILL_SWITCH is engaged — disengage it before enabling automation"
      : "Kill switch is clear",
  });

  // 5 — Coinbase emergency stop clear
  steps.push({
    step: 5,
    name: "Coinbase emergency stop clear",
    passed: !safety.emergencyStop,
    detail: safety.emergencyStop
      ? "Set COINBASE_EMERGENCY_STOP=false"
      : "Coinbase emergency stop is clear",
  });

  // 6 — Daily loss limit configured
  const dailyLossOk = safety.maxDailyLossUsd > 0;
  steps.push({
    step: 6,
    name: "Daily loss cap configured",
    passed: dailyLossOk,
    detail: dailyLossOk
      ? `COINBASE_MAX_DAILY_LOSS=$${safety.maxDailyLossUsd}`
      : "Set COINBASE_MAX_DAILY_LOSS to a positive value (e.g. 50 for a $50/day loss cap)",
  });

  // 7 — Max position USD configured
  const maxPositionOk = safety.maxPositionUsd > 0;
  steps.push({
    step: 7,
    name: "Max position size configured",
    passed: maxPositionOk,
    detail: maxPositionOk
      ? `COINBASE_MAX_POSITION_USD=$${safety.maxPositionUsd}`
      : "Set COINBASE_MAX_POSITION_USD (e.g. 500 for a $500 max position)",
  });

  // 8 — Max risk per trade configured
  const maxRiskOk = safety.maxRiskPerTradeUsd > 0;
  steps.push({
    step: 8,
    name: "Max risk per trade configured",
    passed: maxRiskOk,
    detail: maxRiskOk
      ? `COINBASE_MAX_RISK_PER_TRADE=$${safety.maxRiskPerTradeUsd} (recommended: $10–$25 to start small)`
      : "Set COINBASE_MAX_RISK_PER_TRADE (e.g. 10 to risk $10 per trade)",
  });

  // 9 — Min reward/risk >= 2
  const minRROk = safety.minRewardRisk >= 2;
  steps.push({
    step: 9,
    name: "Min reward/risk ratio >= 2",
    passed: minRROk,
    detail: minRROk
      ? `COINBASE_MIN_REWARD_RISK=${safety.minRewardRisk}`
      : `COINBASE_MIN_REWARD_RISK=${safety.minRewardRisk} — must be >= 2 for positive expectancy`,
  });

  // 10 — Allowed products configured
  const allowedOk = safety.allowedProducts.length > 0;
  steps.push({
    step: 10,
    name: "Allowed products list configured",
    passed: allowedOk,
    detail: allowedOk
      ? `COINBASE_ALLOWED_PRODUCTS=${safety.allowedProducts.join(",")}`
      : "Set COINBASE_ALLOWED_PRODUCTS (e.g. BTC-USD,ETH-USD — start with 1-2 liquid pairs)",
  });

  // 11 — Cooldown >= 15 min
  const cooldownOk = safety.cooldownMinutes >= 15;
  steps.push({
    step: 11,
    name: "Cooldown period >= 15 minutes",
    passed: cooldownOk,
    detail: cooldownOk
      ? `COINBASE_COOLDOWN_MINUTES=${safety.cooldownMinutes}`
      : `COINBASE_COOLDOWN_MINUTES=${safety.cooldownMinutes} — recommend >= 30 to prevent rapid re-entry after a stop`,
  });

  // 12 — Max trades per day >= 1
  const maxTradesOk = safety.maxTradesPerDay >= 1;
  steps.push({
    step: 12,
    name: "Max trades per day >= 1",
    passed: maxTradesOk,
    detail: maxTradesOk
      ? `COINBASE_MAX_TRADES_PER_DAY=${safety.maxTradesPerDay}`
      : "Set COINBASE_MAX_TRADES_PER_DAY >= 1 (start with 1-2)",
  });

  const passed = steps.filter((s) => s.passed).length;
  const total = steps.length;
  const blockers = steps.filter((s) => !s.passed).map((s) => s.name);
  const ready = passed === total;

  const recommendation = ready
    ? "✅ All 12 checks passed. You may set COINBASE_AUTONOMOUS_ENABLED=true to enable automation. Start with very small risk ($10–$25/trade) until you have a live track record."
    : `⚠️ ${blockers.length} check(s) must pass before enabling automation:\n${blockers.map((b) => `  • ${b}`).join("\n")}`;

  return { ready, passed, total, steps, blockers, recommendation };
}

/** Formats the readiness report as a Telegram-friendly text block. */
export function readinessText(report: CoinbaseReadinessReport): string {
  const yn = (b: boolean) => (b ? "✅" : "❌");
  const lines = [
    `🔍 COINBASE AUTONOMY READINESS — ${report.passed}/${report.total} passed`,
    "",
  ];
  for (const s of report.steps) {
    lines.push(`${yn(s.passed)} ${s.step}. ${s.name}`);
    if (!s.passed) lines.push(`   → ${s.detail}`);
  }
  lines.push("", report.recommendation);
  return lines.join("\n");
}
