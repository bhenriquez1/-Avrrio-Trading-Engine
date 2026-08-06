/**
 * Coinbase Autonomous Trading Engine.
 *
 * Executes one trade per cycle at most, only when every safety gate passes.
 * TopstepX is completely separate — this engine never touches TopstepX state,
 * recommendations, or execution paths.
 *
 * Hard rules:
 *   - Never withdraw or transfer funds (enforced by API key permissions)
 *   - Never trade products outside allowedProducts
 *   - Never average down into a losing position
 *   - Never exceed any configured risk limit
 *   - Never bypass the kill switch or emergency stop
 *   - Never trade without valid market data (zero-entry blocked)
 *   - One trade per scan cycle maximum
 */

import type { AvrrioEngine } from "../engine.js";
import { suggestLevels } from "../scanner/scanner.js";
import { sizeCryptoTrade, formatCryptoQty } from "./sizing.js";
import {
  checkSafetyGates,
  type TradingState,
  type TradeCandidate,
} from "./safetyStack.js";
import {
  checkCoinbaseReadiness,
  readinessText,
  type CoinbaseReadinessReport,
} from "./readiness.js";
import { findSymbol } from "../symbols/registry.js";

export interface CoinbasePosition {
  productId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskUsd: number;
  rewardRisk: number;
  orderId: string;
  paper: boolean;
  openedAt: string;
  score: number;
}

export interface AutoCycleResult {
  timestamp: string;
  scanned: number;
  executed: number;
  blocked: number;
  skipped: number;
  trades: CoinbasePosition[];
  blockedReasons: string[];
  nextScanAt: string | null;
}

export class CoinbaseAutonomyEngine {
  private _paused = false;
  private _emergencyStop = false;
  private tradesToday = 0;
  private tradeDay = "";
  private lastTradeTime: Date | null = null;
  private openPositions: CoinbasePosition[] = [];
  private lastCycleResult: AutoCycleResult | null = null;
  private lastCycleTime: string | null = null;

  constructor(private readonly engine: AvrrioEngine) {}

  get isEnabled(): boolean {
    return this.engine.config.coinbase.safety.autonomousEnabled;
  }

  get isPaused(): boolean {
    return this._paused;
  }

  get hasEmergencyStop(): boolean {
    return this._emergencyStop || this.engine.config.coinbase.safety.emergencyStop;
  }

  get isRunning(): boolean {
    return this.isEnabled && !this._paused && !this.hasEmergencyStop;
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
  }

  engageEmergencyStop(): void {
    this._emergencyStop = true;
  }

  clearEmergencyStop(): void {
    this._emergencyStop = false;
  }

  status() {
    const safety = this.engine.config.coinbase.safety;
    return {
      enabled: this.isEnabled,
      paused: this._paused,
      emergencyStop: this.hasEmergencyStop,
      tradingEnabled: safety.tradingEnabled,
      killSwitchEngaged: this.engine.killSwitch.isEngaged(),
      tradesToday: this.tradesToday,
      maxTradesPerDay: safety.maxTradesPerDay,
      openPositions: this.openPositions.length,
      maxOpenPositions: safety.maxOpenPositions,
      lastTradeTime: this.lastTradeTime?.toISOString() ?? null,
      lastCycleTime: this.lastCycleTime,
      lastCycle: this.lastCycleResult,
      autonomousMode: this.isRunning,
      config: {
        maxRiskPerTradeUsd: safety.maxRiskPerTradeUsd,
        maxPositionUsd: safety.maxPositionUsd,
        maxDailyLossUsd: safety.maxDailyLossUsd,
        minRewardRisk: safety.minRewardRisk,
        cooldownMinutes: safety.cooldownMinutes,
        allowedProducts: safety.allowedProducts,
      },
    };
  }

  openPositionsList(): CoinbasePosition[] {
    return [...this.openPositions];
  }

  lastCycle(): AutoCycleResult | null {
    return this.lastCycleResult;
  }

  async readiness(): Promise<CoinbaseReadinessReport> {
    const cfg = this.engine.config.coinbase;
    const credentialsConfigured = !!cfg.apiKeyName && !!cfg.apiKeySecret;
    return checkCoinbaseReadiness(
      cfg.safety,
      credentialsConfigured,
      this.engine.coinbase,
      this.engine.killSwitch.isEngaged(),
    );
  }

  /** Called on each scheduler tick. Executes at most one trade per cycle. */
  async runCycle(): Promise<AutoCycleResult> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    if (this.tradeDay !== today) {
      this.tradeDay = today;
      this.tradesToday = 0;
    }
    this.lastCycleTime = now.toISOString();

    const safety = this.engine.config.coinbase.safety;

    // Build open-symbol set for averaging-down check
    const openSymbols = new Set(
      this.openPositions.map((p) => `${p.productId}:${p.side}`),
    );

    const state: TradingState = {
      tradesToday: this.tradesToday,
      lastTradeTime: this.lastTradeTime,
      openPositionsCount: this.openPositions.length,
      dayLossUsd: 0,
      paused: this._paused,
      emergencyStop: this.hasEmergencyStop,
      killSwitchEngaged: this.engine.killSwitch.isEngaged(),
      openSymbols,
    };

    // Short-circuit: skip scan if global flags prevent any trade
    if (
      !safety.autonomousEnabled ||
      state.paused ||
      state.emergencyStop ||
      state.killSwitchEngaged ||
      !safety.tradingEnabled
    ) {
      const reason = !safety.autonomousEnabled
        ? "COINBASE_AUTONOMOUS_ENABLED=false"
        : state.emergencyStop
          ? "emergency stop"
          : state.paused
            ? "paused by operator"
            : state.killSwitchEngaged
              ? "global kill switch"
              : "COINBASE_TRADING_ENABLED=false";
      const result: AutoCycleResult = {
        timestamp: now.toISOString(),
        scanned: 0,
        executed: 0,
        blocked: 0,
        skipped: 0,
        trades: [],
        blockedReasons: [reason],
        nextScanAt: null,
      };
      this.lastCycleResult = result;
      return result;
    }

    const scanResults = await this.engine.scan({
      classes: ["crypto"],
      limit: 10,
    });

    const executed: CoinbasePosition[] = [];
    const blockedReasons: string[] = [];
    let blockedCount = 0;
    let skipped = 0;

    const minScore = this.engine.config.notifications.opportunityAlertScore;

    for (const r of scanResults) {
      // Only trade clear directional setups
      if (r.direction !== "bullish" && r.direction !== "bearish") {
        skipped++;
        continue;
      }
      if (r.score < minScore) {
        skipped++;
        continue;
      }
      if (r.newsBlocked) {
        blockedReasons.push(`${r.symbol}: news blackout`);
        blockedCount++;
        continue;
      }

      const info = findSymbol(r.symbol);
      if (!info?.coinbaseProductId) {
        skipped++;
        continue;
      }

      const tradeSide = r.direction === "bullish" ? "long" : "short";
      const orderSide: "BUY" | "SELL" = r.direction === "bullish" ? "BUY" : "SELL";

      let snapshot;
      try {
        snapshot = await this.engine.snapshot(r.symbol);
      } catch {
        skipped++;
        continue;
      }

      const levels = suggestLevels(snapshot, tradeSide);
      const stopDist = Math.abs(levels.entry - levels.stopLoss);
      const rewardDist = Math.abs(levels.target - levels.entry);
      const rewardRisk = stopDist > 0 ? rewardDist / stopDist : 0;

      const candidate: TradeCandidate = {
        productId: info.coinbaseProductId,
        side: orderSide,
        entry: levels.entry,
        stopLoss: levels.stopLoss,
        target: levels.target,
        score: r.score,
        rewardRisk,
      };

      // Re-read state for each candidate (tradesToday may have changed within loop)
      const liveState: TradingState = {
        ...state,
        tradesToday: this.tradesToday,
        openPositionsCount: this.openPositions.length,
        openSymbols: new Set(
          this.openPositions.map((p) => `${p.productId}:${p.side}`),
        ),
      };

      const safetyCheck = checkSafetyGates(candidate, safety, liveState);

      if (!safetyCheck.passed) {
        const reason = `${r.symbol}: ${safetyCheck.blockedBy ?? "safety gate"}`;
        blockedReasons.push(reason);
        blockedCount++;
        await this.engine.audit.log("coinbase.autonomy.blocked", "system", {
          symbol: r.symbol,
          productId: info.coinbaseProductId,
          score: r.score,
          blockedBy: safetyCheck.blockedBy,
          gate: safetyCheck.gates.find((g) => !g.passed)?.reason,
        });
        continue;
      }

      const sizing = sizeCryptoTrade({
        entry: levels.entry,
        stopLoss: levels.stopLoss,
        riskDollars: safety.maxRiskPerTradeUsd,
        maxPositionUsd: safety.maxPositionUsd,
        maxRiskPerTradeUsd: safety.maxRiskPerTradeUsd,
      });

      if (sizing.quantity <= 0) {
        blockedReasons.push(`${r.symbol}: zero quantity (entry too close to stop)`);
        blockedCount++;
        continue;
      }

      try {
        const qty = formatCryptoQty(sizing.quantity, levels.entry);
        const result = await this.engine.coinbase.submitOrder({
          productId: info.coinbaseProductId,
          side: orderSide,
          orderType: "market",
          baseSize: qty,
        });

        const position: CoinbasePosition = {
          productId: info.coinbaseProductId,
          symbol: r.symbol,
          side: orderSide,
          quantity: sizing.quantity,
          entry: levels.entry,
          stopLoss: levels.stopLoss,
          target: levels.target,
          riskUsd: sizing.riskDollars,
          rewardRisk,
          orderId: result.orderId,
          paper: result.paper,
          openedAt: now.toISOString(),
          score: r.score,
        };

        this.openPositions.push(position);
        this.tradesToday++;
        this.lastTradeTime = now;
        executed.push(position);

        await this.engine.audit.log("coinbase.autonomy.executed", "system", {
          symbol: r.symbol,
          productId: info.coinbaseProductId,
          side: orderSide,
          qty,
          entry: levels.entry,
          stopLoss: levels.stopLoss,
          target: levels.target,
          riskUsd: sizing.riskDollars,
          rewardRisk: rewardRisk.toFixed(2),
          orderId: result.orderId,
          paper: result.paper,
          score: r.score,
        });

        const modeTag = result.paper ? "[PAPER]" : "[LIVE]";
        const sideEmoji = orderSide === "BUY" ? "📈" : "📉";
        const notif = [
          `${sideEmoji} COINBASE AUTO-TRADE ${modeTag}`,
          `${r.symbol} ${orderSide} ${qty} @ ~$${levels.entry.toLocaleString()}`,
          `Stop: $${levels.stopLoss.toLocaleString()} · Target: $${levels.target.toLocaleString()}`,
          `Risk: $${sizing.riskDollars.toFixed(2)} · R:R ${rewardRisk.toFixed(1)} · Score ${r.score}/100`,
          `Order: ${result.orderId}`,
        ].join("\n");
        void this.engine.telegram.sendText(notif);

        // One trade per cycle — avoid overexposure
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        blockedReasons.push(`${r.symbol}: order failed — ${msg.slice(0, 80)}`);
        blockedCount++;
        await this.engine.audit.log("coinbase.autonomy.order_failed", "system", {
          symbol: r.symbol,
          error: msg.slice(0, 200),
        });
      }
    }

    const intervalMin = this.engine.config.scheduler.intervalMinutes;
    const nextScanAt = new Date(
      now.getTime() + intervalMin * 60_000,
    ).toISOString();

    const result: AutoCycleResult = {
      timestamp: now.toISOString(),
      scanned: scanResults.length,
      executed: executed.length,
      blocked: blockedCount,
      skipped,
      trades: executed,
      blockedReasons,
      nextScanAt,
    };
    this.lastCycleResult = result;
    return result;
  }

  /** Telegram text for /coinbase_status */
  statusText(): string {
    const s = this.status();
    const yn = (b: boolean) => (b ? "✅" : "❌");
    const banner = s.autonomousMode ? "🟢 AUTOMATED" : "⏸️ PAUSED / DISABLED";
    const lines = [
      `🤖 COINBASE AUTONOMY — ${banner}`,
      "",
      `${yn(s.enabled)} COINBASE_AUTONOMOUS_ENABLED`,
      `${yn(!s.paused)} Not paused${s.paused ? " — /coinbase_resume to restart" : ""}`,
      `${yn(!s.emergencyStop)} Emergency stop clear${s.emergencyStop ? " — /coinbase_resume confirm" : ""}`,
      `${yn(s.tradingEnabled)} COINBASE_TRADING_ENABLED${s.tradingEnabled ? "" : " (paper mode)"}`,
      `${yn(!s.killSwitchEngaged)} Global kill switch clear`,
      "",
      `Trades today: ${s.tradesToday}/${s.maxTradesPerDay}`,
      `Open positions: ${s.openPositions}/${s.maxOpenPositions}`,
      `Risk/trade: $${s.config.maxRiskPerTradeUsd} · Max position: $${s.config.maxPositionUsd}`,
      `Min R:R: ${s.config.minRewardRisk} · Cooldown: ${s.config.cooldownMinutes}m`,
      `Allowed: ${s.config.allowedProducts.join(", ") || "all registered"}`,
    ];
    if (s.lastTradeTime)
      lines.push(`Last trade: ${new Date(s.lastTradeTime).toLocaleString()}`);
    if (s.lastCycleTime)
      lines.push(`Last scan: ${new Date(s.lastCycleTime).toLocaleString()}`);
    return lines.join("\n");
  }

  /** Telegram text for /coinbase_why */
  whyText(): string {
    const cycle = this.lastCycleResult;
    if (!cycle) {
      return "No Coinbase scan has run yet. Enable the scheduler and set COINBASE_AUTONOMOUS_ENABLED=true.";
    }
    const lines = [
      `🤔 COINBASE WHY NO AUTO-TRADE`,
      `Last scan: ${new Date(cycle.timestamp).toLocaleTimeString()} · scanned ${cycle.scanned} · executed ${cycle.executed} · blocked ${cycle.blocked}`,
    ];
    if (cycle.blockedReasons.length) {
      lines.push("", "Reasons:");
      for (const r of cycle.blockedReasons.slice(0, 8)) {
        lines.push(`• ${r}`);
      }
    } else if (cycle.executed === 0) {
      lines.push("", "No qualifying crypto setups — Avrrio Score below threshold or no clear trend.");
    }
    return lines.join("\n");
  }

  /** Telegram text for /coinbase_positions */
  positionsText(): string {
    if (!this.openPositions.length) return "📭 No open Coinbase positions.";
    const lines = ["📋 COINBASE OPEN POSITIONS"];
    for (const p of this.openPositions) {
      lines.push(
        `${p.symbol} ${p.side} ${p.quantity.toFixed(6)} @ $${p.entry.toLocaleString()}` +
          ` · stop $${p.stopLoss.toLocaleString()} · target $${p.target.toLocaleString()}` +
          ` · R:R ${p.rewardRisk.toFixed(1)} · risk $${p.riskUsd.toFixed(2)}` +
          (p.paper ? " [PAPER]" : " [LIVE]"),
      );
    }
    return lines.join("\n");
  }

  /** Telegram text for /coinbase_readiness */
  async readinessTextCmd(): Promise<string> {
    const report = await this.readiness();
    return readinessText(report);
  }
}
