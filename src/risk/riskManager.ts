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
 * The risk manager — the heart of the project.
 *
 * It does not predict the market. It answers one question: "Does this trade
 * idea respect the account rules and the operator's own discipline policy?"
 * A blocked idea should never be acted on.
 */
export class RiskManager {
  constructor(private readonly policy: EngineRiskPolicy = DEFAULT_POLICY) {}

  assess(idea: TradeIdea, account: AccountSummary): RiskAssessment {
    const violations: RuleViolation[] = [];
    const pv = pointValue(idea.symbol);

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
      // Remaining loss budget before the account locks for the day.
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

    const approved = !violations.some((v) => v.severity === "block");
    return { approved, riskAmount, rewardRiskRatio, violations };
  }
}
