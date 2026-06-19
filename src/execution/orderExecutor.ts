import type { AuditLog } from "../audit/auditLog.js";
import type { AvrrioConfig } from "../config.js";
import type { KillSwitch } from "../safety/killSwitch.js";
import type { TopstepClient } from "../topstep/client.js";
import type { OrderResult } from "../types.js";
import type { Recommendation, RecommendationStore } from "./recommendations.js";

/**
 * The only path to a real order. Every safety gate is re-checked here at the
 * moment of execution — not just when the recommendation was created — so a
 * kill-switch trip or a flipped flag between proposal and approval still stops
 * the trade.
 */
export class OrderExecutor {
  constructor(
    private readonly config: AvrrioConfig,
    private readonly client: TopstepClient,
    private readonly killSwitch: KillSwitch,
    private readonly store: RecommendationStore,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Execute an approved recommendation. `actor` is the operator (manual approval)
   * or "system" (semi-autonomous). Returns the (possibly paper) order result, or
   * throws if a gate blocks it.
   */
  async execute(rec: Recommendation, actor: string): Promise<OrderResult> {
    // Final, authoritative gates — re-evaluated at execution time.
    if (this.killSwitch.isEngaged()) {
      await this.block(rec, actor, "kill switch engaged");
      throw new Error("Blocked: kill switch is engaged.");
    }
    if (!rec.riskApproved) {
      await this.block(rec, actor, "risk not approved");
      throw new Error("Blocked: recommendation failed risk checks.");
    }
    if (rec.status === "executed") {
      throw new Error("Recommendation already executed.");
    }

    const live = this.config.execution.liveTradingEnabled;
    const result = await this.client.submitOrder(
      {
        symbol: rec.symbol,
        side: rec.side,
        size: rec.size,
        entry: rec.entry,
        stopLoss: rec.stopLoss,
        target: rec.target,
      },
      live,
    );

    rec.status = "executed";
    rec.decidedBy = actor;
    rec.decidedAt = new Date().toISOString();
    rec.orderResult = result;
    await this.store.update(rec);

    await this.audit.log("order.executed", actor, {
      recommendationId: rec.id,
      symbol: rec.symbol,
      side: rec.side,
      size: rec.size,
      live,
      paper: result.paper,
      orderId: result.orderId,
    });

    return result;
  }

  async reject(rec: Recommendation, actor: string, reason = ""): Promise<void> {
    rec.status = "rejected";
    rec.decidedBy = actor;
    rec.decidedAt = new Date().toISOString();
    await this.store.update(rec);
    await this.audit.log("order.rejected", actor, {
      recommendationId: rec.id,
      reason,
    });
  }

  private async block(
    rec: Recommendation,
    actor: string,
    reason: string,
  ): Promise<void> {
    rec.status = "blocked";
    await this.store.update(rec);
    await this.audit.log("order.blocked", actor, {
      recommendationId: rec.id,
      reason,
    });
  }
}
