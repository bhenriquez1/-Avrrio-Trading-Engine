import type { AvrrioConfig } from "../config.js";
import type { AvrrioEngine } from "../engine.js";
import { suggestLevels } from "../scanner/scanner.js";
import type { Side } from "../types.js";

export interface ScanCycleResult {
  scanned: number;
  qualifying: number;
  alerted: number;
  /** Refs of recommendations created this cycle. */
  refs: string[];
}

/**
 * Scheduled opportunity scanner. Every N minutes it scans the universe, scores
 * each symbol, and alerts ONLY on high-quality, tradable futures setups:
 *
 *   Avrrio Score >= minScore  AND  reward/risk >= minRewardRisk
 *
 * It caps alerts to the top `maxAlerts` per cycle so the phone gets the best 1–3
 * ideas, not noise — and sends nothing when nothing qualifies. Duplicate symbols
 * with an open recommendation are skipped by the propose() risk stack.
 *
 * An optional end-of-day summary SMS is sent once when the local clock crosses
 * `dailySummaryHour`.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private scansToday = 0;
  private summaryDay = ""; // YYYY-MM-DD the summary was last sent
  private readonly minScore: number;

  constructor(
    private readonly engine: AvrrioEngine,
    private readonly config: AvrrioConfig,
  ) {
    this.minScore = config.notifications.opportunityAlertScore;
  }

  get enabled(): boolean {
    return this.config.scheduler.enabled;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    const ms = Math.max(1, this.config.scheduler.intervalMinutes) * 60_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    console.log(
      `Scheduled scanner ON: every ${this.config.scheduler.intervalMinutes} min, ` +
        `score>=${this.minScore}, R/R>=${this.config.scheduler.minRewardRisk}, top ${this.config.scheduler.maxAlerts}.`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    try {
      await this.runScanCycle();
      await this.maybeDailySummary();
    } catch (err) {
      console.error("scheduler tick error:", err);
    }
  }

  /** Runs one scan cycle and creates/alerts qualifying recommendations. */
  async runScanCycle(): Promise<ScanCycleResult> {
    this.scansToday++;
    const results = await this.engine.scan({ limit: 12 });
    const minRR = this.config.scheduler.minRewardRisk;

    // Qualify: tradable (futures only), strong score, clear direction.
    const candidates = results.filter(
      (r) =>
        r.tradable &&
        r.score >= this.minScore &&
        (r.direction === "bullish" || r.direction === "bearish"),
    );

    const refs: string[] = [];
    let alerted = 0;
    for (const r of candidates) {
      if (alerted >= this.config.scheduler.maxAlerts) break;
      const side: Side = r.direction === "bullish" ? "long" : "short";
      const snapshot = await this.engine.snapshot(r.symbol);
      const levels = suggestLevels(snapshot, side);
      const rr =
        Math.abs(levels.target - levels.entry) /
        Math.max(1e-9, Math.abs(levels.entry - levels.stopLoss));
      if (rr < minRR) continue;

      const rec = await this.engine.propose({
        symbol: r.symbol,
        side,
        size: 1,
        entry: round(levels.entry),
        stopLoss: round(levels.stopLoss),
        target: round(levels.target),
      });
      if (rec.status === "pending") {
        alerted++;
        refs.push(rec.ref);
        await this.engine.audit.log("scheduler.alert", "system", {
          ref: rec.ref,
          symbol: rec.symbol,
          side,
          score: r.score,
          rewardRisk: Number(rr.toFixed(2)),
        });
      }
    }

    return {
      scanned: results.length,
      qualifying: candidates.length,
      alerted,
      refs,
    };
  }

  private async maybeDailySummary(): Promise<void> {
    const hour = this.config.scheduler.dailySummaryHour;
    if (hour < 0) return;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() === hour && this.summaryDay !== day) {
      this.summaryDay = day;
      const text = this.engine.dailySummaryText(this.scansToday);
      await this.engine.notifyText(text, "scheduler.daily_summary");
      this.scansToday = 0; // reset for the new day
    }
  }

  stats() {
    return { enabled: this.enabled, scansToday: this.scansToday };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
