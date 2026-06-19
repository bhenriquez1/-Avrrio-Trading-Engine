import type {
  AccountSummary,
  RiskAssessment,
  RuleViolation,
  TradeIdea,
} from "../types.js";
import {
  DEFAULT_POLICY,
  type EngineRiskPolicy,
  pointValue,
  stopIsValid,
  targetIsValid,
} from "./rules.js";

/**
 * Optional execution-time context. When provided, the risk manager runs the full
 * semi-autonomous safety stack (kill switch, daily-loss budget, trade count,
 * duplicates, news). When omitted, only the structural + account-rule checks run
 * (used by the Phase 1 idea evaluator and unit tests).
 */
export interface RiskContext {
  /** Whether the symbol is tradable (futures). Stocks/crypto are watchlist-only. */
  symbolTradable?: boolean;
  killSwitchEngaged?: boolean;
  /** Result of the news reader for this symbol/window. */
  news?: { blocked: boolean; reason: string };
  /** Operator override permitting a trade despite a news block. */
  newsOverride?: boolean;
  /** Trades already taken today (for the per-day cap). */
  tradesToday?: number;
  /** True if there is already an open position/idea on this symbol+side. */
  duplicateOpen?: boolean;
  /** True if the prospective trade is inside its setup's allowed hours. */
  withinAllowedHours?: boolean;
  /** Engine-level absolute safety limits (from config). */
  safety?: {
    maxPositionSize: number;
    maxTradesPerDay: number;
    maxRiskPerTrade: number;
  };
}

/**
 * The risk manager — the heart of the project. It never predicts the market; it
 * answers one question: "Does this trade respect every account rule, engine
 * limit, and safety gate?" A blocked idea must never be acted on.
 */
export class RiskManager {
  constructor(private readonly policy: EngineRiskPolicy = DEFAULT_POLICY) {}

  assess(
    idea: TradeIdea,
    account: AccountSummary,
    context: RiskContext = {},
  ): RiskAssessment {
    const violations: RuleViolation[] = [];
    const pv = pointValue(idea.symbol);

    // --- highest-priority hard gates ----------------------------------
    if (context.symbolTradable === false) {
      violations.push({
        rule: "untradable-symbol",
        message: `${idea.symbol} is watchlist/analysis-only and cannot be traded (futures only).`,
        severity: "block",
      });
    }

    if (context.killSwitchEngaged) {
      violations.push({
        rule: "kill-switch",
        message: "Kill switch is engaged — all trading is blocked.",
        severity: "block",
      });
    }

    if (context.news?.blocked && !context.newsOverride) {
      violations.push({
        rule: "news-risk",
        message: context.news.reason,
        severity: "block",
      });
    }

    // --- structural validity ------------------------------------------
    if (idea.size <= 0) {
      violations.push({
        rule: "size",
        message: "Position size must be greater than zero.",
        severity: "block",
      });
    }

    if (this.policy.requireStopLoss && !idea.stopLoss) {
      violations.push({
        rule: "stop-required",
        message: "No stop loss set. Every trade must define a stop.",
        severity: "block",
      });
    }

    if (idea.stopLoss && !stopIsValid(idea.side, idea.entry, idea.stopLoss)) {
      violations.push({
        rule: "stop-side",
        message: `Stop ${idea.stopLoss} is on the wrong side of entry ${idea.entry} for a ${idea.side} trade.`,
        severity: "block",
      });
    }

    if (idea.target && !targetIsValid(idea.side, idea.entry, idea.target)) {
      violations.push({
        rule: "target-side",
        message: `Target ${idea.target} is on the wrong side of entry ${idea.entry} for a ${idea.side} trade.`,
        severity: "block",
      });
    }

    // --- dollar risk / reward -----------------------------------------
    const riskPoints = Math.abs(idea.entry - idea.stopLoss);
    const rewardPoints = Math.abs(idea.target - idea.entry);
    const riskAmount = riskPoints * idea.size * pv;
    const rewardRiskRatio = riskPoints > 0 ? rewardPoints / riskPoints : 0;

    if (rewardRiskRatio < this.policy.minRewardRiskRatio) {
      violations.push({
        rule: "reward-risk",
        message: `Reward/risk ${rewardRiskRatio.toFixed(2)} is below the minimum ${this.policy.minRewardRiskRatio}.`,
        severity: "block",
      });
    }

    // --- account rule checks ------------------------------------------
    const { rules } = account;

    if (rules.maxPositionSize > 0 && idea.size > rules.maxPositionSize) {
      violations.push({
        rule: "max-position-size",
        message: `Size ${idea.size} exceeds account max of ${rules.maxPositionSize} contracts.`,
        severity: "block",
      });
    }

    if (rules.maxDailyLoss > 0) {
      const lossUsed = Math.max(0, -account.dayPnl);
      const remaining = rules.maxDailyLoss - lossUsed;
      if (riskAmount > remaining) {
        violations.push({
          rule: "daily-loss-budget",
          message: `Trade risks $${riskAmount.toFixed(0)} but only $${remaining.toFixed(0)} of the daily loss budget remains.`,
          severity: "block",
        });
      } else if (
        riskAmount >
        rules.maxDailyLoss * this.policy.maxRiskFractionOfDailyLoss
      ) {
        violations.push({
          rule: "risk-concentration",
          message: `Trade risks $${riskAmount.toFixed(0)}, more than ${(this.policy.maxRiskFractionOfDailyLoss * 100).toFixed(0)}% of the daily loss limit on a single trade.`,
          severity: "warn",
        });
      }
    }

    // --- engine-level safety limits (semi-autonomous stack) -----------
    const safety = context.safety;
    if (safety) {
      if (safety.maxPositionSize > 0 && idea.size > safety.maxPositionSize) {
        violations.push({
          rule: "engine-max-position-size",
          message: `Size ${idea.size} exceeds engine MAX_POSITION_SIZE of ${safety.maxPositionSize}.`,
          severity: "block",
        });
      }
      if (safety.maxRiskPerTrade > 0 && riskAmount > safety.maxRiskPerTrade) {
        violations.push({
          rule: "max-risk-per-trade",
          message: `Trade risks $${riskAmount.toFixed(0)}, above MAX_RISK_PER_TRADE of $${safety.maxRiskPerTrade}.`,
          severity: "block",
        });
      }
      if (
        safety.maxTradesPerDay > 0 &&
        (context.tradesToday ?? 0) >= safety.maxTradesPerDay
      ) {
        violations.push({
          rule: "max-trades-per-day",
          message: `Already took ${context.tradesToday} trades today; limit is ${safety.maxTradesPerDay}.`,
          severity: "block",
        });
      }
    }

    if (context.duplicateOpen) {
      violations.push({
        rule: "duplicate-trade",
        message: `An open ${idea.side} position/idea on ${idea.symbol} already exists.`,
        severity: "block",
      });
    }

    if (context.withinAllowedHours === false) {
      violations.push({
        rule: "trading-hours",
        message: "Outside the setup's allowed trading hours.",
        severity: "block",
      });
    }

    const approved = !violations.some((v) => v.severity === "block");
    return { approved, riskAmount, rewardRiskRatio, violations };
  }
}
