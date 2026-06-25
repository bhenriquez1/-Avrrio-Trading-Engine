import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Side } from "../types.js";

/**
 * Avrrio Memory — a persisted record of how the operator's trades actually
 * turn out, so Avrrio can learn their habits and warn before repeating a
 * losing pattern (e.g. "72% win rate on pullbacks but 34% on breakouts").
 *
 * It is descriptive analytics only: it never places, approves, or blocks a
 * trade. Its output is advice the operator can act on or ignore.
 */

export type TradeResult = "win" | "loss" | "scratch";

/** One completed trade, captured at close with enough context to learn from. */
export interface MemoryRecord {
  closedAt: string; // ISO timestamp
  symbol: string;
  /** Normalised setup name, lower-cased; "unknown" when none was given. */
  setup: string;
  side: Side;
  /** Avrrio score at entry, if known. */
  score: number | null;
  /** Reward/risk at entry, if known. */
  rewardRisk: number | null;
  /** Local hour of entry (0–23), if known. */
  entryHour: number | null;
  result: TradeResult;
  pnl: number;
}

export type NewMemoryRecord = Omit<MemoryRecord, "closedAt" | "result" | "setup"> & {
  /** Normalised on add; null/empty becomes "unknown". */
  setup: string | null;
  closedAt?: string;
  /** If omitted, derived from the sign of pnl. */
  result?: TradeResult;
};

/** Aggregated performance for a cohort (a setup, a side, an hour bucket, …). */
export interface CohortStat {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  /** 0..1; null when there are no decisive (non-scratch) trades. */
  winRate: number | null;
  netPnl: number;
}

export type MemoryLevel = "favorable" | "neutral" | "caution" | "warn" | "insufficient";

export interface MemoryAssessment {
  matched: boolean;
  level: MemoryLevel;
  sampleSize: number;
  winRate: number | null;
  message: string;
}

/** How a candidate trade is matched against history. */
export interface MemoryQuery {
  setup?: string | null;
  side?: Side | null;
  score?: number | null;
  entryHour?: number | null;
}

/** Minimum decisive trades before a cohort's win rate is considered meaningful. */
const MIN_SAMPLE = 5;

export class TradeMemory {
  private records: MemoryRecord[] = [];

  constructor(private readonly path = "data/memory.json") {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      this.records = JSON.parse(raw) as MemoryRecord[];
    } catch {
      this.records = [];
    }
  }

  all(): readonly MemoryRecord[] {
    return this.records;
  }

  count(): number {
    return this.records.length;
  }

  async add(rec: NewMemoryRecord): Promise<MemoryRecord> {
    const full: MemoryRecord = {
      ...rec,
      setup: normaliseSetup(rec.setup),
      closedAt: rec.closedAt ?? new Date().toISOString(),
      result: rec.result ?? resultFromPnl(rec.pnl),
    };
    this.records.push(full);
    await this.persist();
    return full;
  }

  // --- aggregations -----------------------------------------------------

  overall(): CohortStat {
    return aggregate("overall", this.records);
  }

  bySetup(): CohortStat[] {
    return groupStats(this.records, (r) => r.setup).sort((a, b) => b.trades - a.trades);
  }

  bySide(): CohortStat[] {
    return groupStats(this.records, (r) => r.side);
  }

  /** Win rate per local hour (only hours that have trades). */
  byHour(): CohortStat[] {
    return groupStats(
      this.records.filter((r) => r.entryHour != null),
      (r) => String(r.entryHour),
    ).sort((a, b) => Number(a.key) - Number(b.key));
  }

  /**
   * Human-readable insights, strongest signals first. Each is backed by enough
   * samples to be meaningful; returns an empty list until there's history.
   */
  insights(): string[] {
    const out: string[] = [];
    const setups = this.bySetup().filter((s) => decisive(s) >= MIN_SAMPLE && s.winRate != null);

    const best = [...setups].sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0];
    const worst = [...setups].sort((a, b) => (a.winRate ?? 0) - (b.winRate ?? 0))[0];
    if (best && worst && best.key !== worst.key) {
      out.push(
        `You win ${pct(best.winRate)} on ${best.key} (n=${decisive(best)}) but only ${pct(worst.winRate)} on ${worst.key} (n=${decisive(worst)}).`,
      );
    } else if (best) {
      out.push(`Your ${best.key} setups win ${pct(best.winRate)} (n=${decisive(best)}).`);
    }

    // Best trading hour, if there is a clear standout with enough data.
    const hours = this.byHour().filter((h) => decisive(h) >= MIN_SAMPLE && h.winRate != null);
    const bestHour = [...hours].sort((a, b) => (b.winRate ?? 0) - (a.winRate ?? 0))[0];
    if (bestHour) {
      out.push(`You perform best around ${formatHour(Number(bestHour.key))} — ${pct(bestHour.winRate)} win rate (n=${decisive(bestHour)}).`);
    }

    // Side bias.
    const sides = this.bySide().filter((s) => decisive(s) >= MIN_SAMPLE && s.winRate != null);
    if (sides.length === 2) {
      const [a, b] = sides.sort((x, y) => (y.winRate ?? 0) - (x.winRate ?? 0));
      if (a && b && (a.winRate ?? 0) - (b.winRate ?? 0) >= 0.2) {
        out.push(`Your ${a.key} trades (${pct(a.winRate)}) clearly outperform your ${b.key} trades (${pct(b.winRate)}).`);
      }
    }
    return out;
  }

  /**
   * Assess a candidate trade against history. Looks for the most specific cohort
   * with enough samples (setup+side, then setup) and flags it when the win rate
   * is poor — the "this resembles a pattern you've struggled with" warning.
   */
  assess(query: MemoryQuery): MemoryAssessment {
    const setup = normaliseSetup(query.setup ?? undefined);
    const candidates = this.records.filter((r) => r.setup === setup);
    const sided = query.side ? candidates.filter((r) => r.side === query.side) : candidates;

    // Prefer the setup+side cohort when it has enough data, else setup alone.
    const cohort = decisiveCount(sided) >= MIN_SAMPLE ? sided : candidates;
    const label = cohort === sided && query.side ? `${query.side} ${setup}` : setup;
    const n = decisiveCount(cohort);
    if (setup === "unknown" || n < MIN_SAMPLE) {
      return {
        matched: false,
        level: "insufficient",
        sampleSize: n,
        winRate: null,
        message:
          setup === "unknown"
            ? "No setup label on this trade, so there's no historical pattern to compare."
            : `Not enough history on ${label} yet (n=${n}); Avrrio needs ~${MIN_SAMPLE}+ closed trades to judge.`,
      };
    }
    const wins = cohort.filter((r) => r.result === "win").length;
    const winRate = wins / n;
    let level: MemoryLevel;
    let message: string;
    if (winRate < 0.4) {
      level = "warn";
      message = `⚠️ This resembles a pattern you've struggled with: ${label} wins only ${pct(winRate)} for you (n=${n}). Consider waiting for confirmation.`;
    } else if (winRate < 0.5) {
      level = "caution";
      message = `Caution: your ${label} setups are roughly coin-flip (${pct(winRate)} over n=${n}).`;
    } else if (winRate >= 0.6) {
      level = "favorable";
      message = `This is in your wheelhouse: ${label} wins ${pct(winRate)} for you (n=${n}).`;
    } else {
      level = "neutral";
      message = `Your ${label} setups are about average (${pct(winRate)} over n=${n}).`;
    }
    return { matched: true, level, sampleSize: n, winRate, message };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.records, null, 2), "utf8");
  }
}

// --- helpers ------------------------------------------------------------

function normaliseSetup(setup: string | null | undefined): string {
  const s = (setup ?? "").trim().toLowerCase();
  return s || "unknown";
}

function resultFromPnl(pnl: number): TradeResult {
  if (pnl > 0) return "win";
  if (pnl < 0) return "loss";
  return "scratch";
}

/** Decisive (non-scratch) trades in a record list. */
function decisiveCount(records: MemoryRecord[]): number {
  return records.filter((r) => r.result !== "scratch").length;
}

/** Decisive trades represented by a CohortStat. */
function decisive(stat: CohortStat): number {
  return stat.wins + stat.losses;
}

function aggregate(key: string, records: MemoryRecord[]): CohortStat {
  const wins = records.filter((r) => r.result === "win").length;
  const losses = records.filter((r) => r.result === "loss").length;
  const decisiveN = wins + losses;
  const netPnl = records.reduce((sum, r) => sum + r.pnl, 0);
  return {
    key,
    trades: records.length,
    wins,
    losses,
    winRate: decisiveN > 0 ? wins / decisiveN : null,
    netPnl: Math.round(netPnl),
  };
}

function groupStats(
  records: MemoryRecord[],
  keyOf: (r: MemoryRecord) => string,
): CohortStat[] {
  const groups = new Map<string, MemoryRecord[]>();
  for (const r of records) {
    const k = keyOf(r);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  return [...groups.entries()].map(([k, rs]) => aggregate(k, rs));
}

function pct(n: number | null): string {
  return n == null ? "n/a" : `${Math.round(n * 100)}%`;
}

function formatHour(hour: number): string {
  const h = ((hour + 11) % 12) + 1;
  const ap = hour < 12 ? "am" : "pm";
  return `${h}${ap}`;
}
