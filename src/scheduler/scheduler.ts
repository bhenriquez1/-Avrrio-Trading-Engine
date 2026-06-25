import type { AvrrioConfig } from "../config.js";
import type { AvrrioEngine } from "../engine.js";
import { suggestLevels, type ScanResult } from "../scanner/scanner.js";
import type { RuntimeSettings } from "../settings/runtimeSettings.js";
import type { Side } from "../types.js";

export interface ScanCycleResult {
  scanned: number;
  qualifying: number;
  alerted: number;
  /** Refs of recommendations created this cycle. */
  refs: string[];
}

/** A setup that did not qualify, with why — for "near-miss" feedback. */
export interface NearMiss {
  symbol: string;
  side: Side | null;
  score: number;
  tradable: boolean;
  rr: number | null;
  reasons: string[];
}

/** Summary of the most recent scan, for /why and /last_signal. */
export interface LastScanSummary {
  time: string;
  scanned: number;
  qualifying: number;
  alerted: number;
  refs: string[];
  /** Plain-language reasons nothing (more) qualified. */
  reasons: string[];
  /** Top non-qualifying setups, ranked by score, with why each failed. */
  nearMisses: NearMiss[];
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
  private scanDay = "";
  private summaryDay = ""; // YYYY-MM-DD the summary was last sent
  private lastScanTime: string | null = null;
  private lastAlertTime: string | null = null;
  private lastSummary: LastScanSummary | null = null;
  /** Keys "YYYY-MM-DD:HH" already reported, so each slot fires once per day. */
  private readonly reportsSent = new Set<string>();
  /** Keys "YYYY-MM-DD:symbol:side" already watch-alerted, deduped per day. */
  private readonly watchAlerted = new Set<string>();
  private readonly minScore: number;

  constructor(
    private readonly engine: AvrrioEngine,
    private readonly config: AvrrioConfig,
    private readonly settings: RuntimeSettings,
  ) {
    this.minScore = config.notifications.opportunityAlertScore;
  }

  get enabled(): boolean {
    return this.settings.isSchedulerEnabled();
  }
  get intervalMinutes(): number {
    return this.settings.getSchedulerInterval();
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    const ms = Math.max(1, this.intervalMinutes) * 60_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    console.log(
      `Scheduled scanner ON: every ${this.intervalMinutes} min, ` +
        `score>=${this.minScore}, R/R>=${this.config.scheduler.minRewardRisk}, top ${this.config.scheduler.maxAlerts}.`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Apply a runtime enable/disable + interval change and (re)start the timer. */
  async configure(enabled: boolean, intervalMinutes?: number): Promise<void> {
    await this.settings.setScheduler(enabled, intervalMinutes);
    this.stop();
    if (enabled) this.start();
  }

  private async tick(): Promise<void> {
    try {
      await this.runScanCycle();
      await this.maybeReports();
      await this.maybeDailySummary();
    } catch (err) {
      console.error("scheduler tick error:", err);
    }
  }

  /**
   * Send the morning / midday / closing reports once each, when the local clock
   * reaches a configured REPORT_HOURS hour. Read-only — never places trades.
   */
  private async maybeReports(): Promise<void> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const hour = now.getHours();
    for (const h of this.config.scheduler.reportHours) {
      if (hour !== h) continue;
      const key = `${day}:${h}`;
      if (this.reportsSent.has(key)) continue;
      this.reportsSent.add(key);
      const slot = reportSlot(h);
      await this.engine.sendScheduledReport(slot, this.scansToday);
      await this.engine.audit.log("scheduler.report", "system", { slot, hour: h });
    }
  }

  /** Runs one scan cycle and creates/alerts qualifying recommendations. */
  async runScanCycle(): Promise<ScanCycleResult> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.scanDay !== today) {
      this.scanDay = today;
      this.scansToday = 0;
      this.watchAlerted.clear(); // fresh watch dedupe each day
    }
    this.scansToday++;
    this.lastScanTime = new Date().toISOString();
    this.engine.stage("SCAN_STARTED", { interval: this.intervalMinutes });
    await this.engine.audit.log("scan.started", "system", {
      intervalMinutes: this.intervalMinutes,
      minScore: this.minScore,
      minRewardRisk: this.config.scheduler.minRewardRisk,
    });
    const results = await this.engine.scan({ limit: 12 });
    this.engine.stage("MARKET_DATA_FETCHED", { symbols: results.length });
    const minRR = this.config.scheduler.minRewardRisk;
    const reasons = new Set<string>();

    // Qualify: tradable (futures only), strong score, clear direction.
    const candidates = results.filter((r) => {
      if (!r.tradable) {
        reasons.add("watchlist-only symbol (futures only)");
        return false;
      }
      if (r.score < this.minScore) {
        reasons.add(`Avrrio score below threshold (${this.minScore})`);
        return false;
      }
      if (r.direction !== "bullish" && r.direction !== "bearish") {
        reasons.add("trend/direction not aligned");
        return false;
      }
      if (r.newsBlocked) {
        reasons.add("news risk (blackout window)");
        return false;
      }
      return true;
    });
    this.engine.stage("SETUP_EVALUATED", {
      scanned: results.length,
      qualifying: candidates.length,
    });

    const refs: string[] = [];
    const alertedSymbols = new Set<string>();
    let alerted = 0;
    for (const r of candidates) {
      if (alerted >= this.config.scheduler.maxAlerts) break;
      const side: Side = r.direction === "bullish" ? "long" : "short";
      const snapshot = await this.engine.snapshot(r.symbol);
      const levels = suggestLevels(snapshot, side);
      const rr =
        Math.abs(levels.target - levels.entry) /
        Math.max(1e-9, Math.abs(levels.entry - levels.stopLoss));
      if (rr < minRR) {
        reasons.add(`reward/risk below ${minRR}:1`);
        continue;
      }

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
        alertedSymbols.add(r.symbol);
        this.lastAlertTime = new Date().toISOString();
        this.engine.stage("TRADE_APPROVED", { ref: rec.ref, symbol: rec.symbol, side });
        await this.engine.audit.log("scheduler.alert", "system", {
          ref: rec.ref,
          symbol: rec.symbol,
          side,
          score: r.score,
          rewardRisk: Number(rr.toFixed(2)),
        });
      } else {
        // Risk stack blocked it — capture why (e.g. daily-loss, position size).
        const rule = rec.violations?.map((v) => v.rule).join(", ") || rec.status;
        reasons.add(`risk check blocked ${r.symbol} (${rule})`);
        this.engine.stage("TRADE_REJECTED", { symbol: r.symbol, reason: rule });
      }
    }

    // Near-miss analysis (never lowers filters) + deduped watch alerts.
    const nearMisses = await this.computeNearMisses(results, alertedSymbols);
    await this.maybeWatchAlerts(today, nearMisses);

    const reasonList = [...reasons];
    if (alerted === 0 && reasonList.length === 0) reasonList.push("no valid setup");
    this.lastSummary = {
      time: this.lastScanTime,
      scanned: results.length,
      qualifying: candidates.length,
      alerted,
      refs,
      reasons: reasonList,
      nearMisses,
    };

    // Record the outcome so the audit log shows the scheduler ran even when
    // nothing qualified (no Telegram message is sent in that case).
    await this.engine.audit.log("scan.completed", "system", {
      scanned: results.length,
      qualifying: candidates.length,
      alerted,
      refs,
    });
    if (alerted === 0) {
      await this.engine.audit.log("no_qualified_setups", "system", {
        scanned: results.length,
        qualifying: candidates.length,
        reasons: reasonList,
      });
    }

    return {
      scanned: results.length,
      qualifying: candidates.length,
      alerted,
      refs,
    };
  }

  /** Most recent scan summary (counts + no-trade reasons), if any. */
  lastScan(): LastScanSummary | null {
    return this.lastSummary;
  }

  /**
   * Top non-qualifying setups ranked by score, each annotated with why it failed.
   * Read-only — never proposes a trade and never lowers a filter.
   */
  private async computeNearMisses(
    results: ScanResult[],
    alertedSymbols: Set<string>,
  ): Promise<NearMiss[]> {
    const minRR = this.config.scheduler.minRewardRisk;
    const pool = results
      .filter((r) => !alertedSymbols.has(r.symbol))
      .sort((a, b) => b.score - a.score);
    const out: NearMiss[] = [];
    for (const r of pool) {
      if (out.length >= 3) break;
      const side: Side | null =
        r.direction === "bullish" ? "long" : r.direction === "bearish" ? "short" : null;
      const reasons: string[] = [];
      if (!r.tradable) reasons.push("watchlist-only (not futures)");
      if (r.score < this.minScore) reasons.push(`Avrrio score ${r.score} < ${this.minScore}`);
      if (!side) reasons.push("trend/direction not aligned");
      if (r.newsBlocked) reasons.push("news/chop filter");
      let rr: number | null = null;
      if (side && r.tradable) {
        try {
          const snap = await this.engine.snapshot(r.symbol);
          const lv = suggestLevels(snap, side);
          rr = Math.abs(lv.target - lv.entry) / Math.max(1e-9, Math.abs(lv.entry - lv.stopLoss));
          if (rr < minRR) reasons.push(`reward/risk ${rr.toFixed(1)} < ${minRR}`);
          if (this.engine.recommendations?.hasOpenDuplicate?.(r.symbol, side))
            reasons.push("duplicate open position");
        } catch {
          /* snapshot optional */
        }
      }
      out.push({
        symbol: r.symbol,
        side,
        score: r.score,
        tradable: r.tradable,
        rr: rr != null ? Number(rr.toFixed(1)) : null,
        reasons,
      });
    }
    return out;
  }

  /**
   * Sends a deduped "watch" alert for a tradable setup that is close but not
   * ready (within watchMargin of the score threshold). Once per symbol+side per
   * day, capped. Separate from real trade alerts; never executes anything.
   */
  private async maybeWatchAlerts(day: string, nearMisses: NearMiss[]): Promise<void> {
    if (!this.config.scheduler.watchAlertsEnabled) return;
    let sent = 0;
    for (const nm of nearMisses) {
      if (sent >= this.config.scheduler.maxAlerts) break;
      if (!nm.tradable || !nm.side) continue;
      if (nm.score < this.minScore - this.config.scheduler.watchMargin) continue;
      const key = `${day}:${nm.symbol}:${nm.side}`;
      if (this.watchAlerted.has(key)) continue;
      this.watchAlerted.add(key);
      await this.engine.sendWatchAlert?.(nm);
      sent++;
    }
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
    return {
      enabled: this.enabled,
      intervalMinutes: this.intervalMinutes,
      scansToday: this.scansToday,
      lastScanTime: this.lastScanTime,
      lastAlertTime: this.lastAlertTime,
    };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Maps a report hour to a slot: before 11 = morning, 11–14 = midday, else closing. */
function reportSlot(hour: number): "morning" | "midday" | "closing" {
  if (hour < 11) return "morning";
  if (hour < 15) return "midday";
  return "closing";
}
