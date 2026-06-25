/**
 * Trade Coach — automatic post-trade review.
 *
 * After a trade is taken, Avrrio reviews it against the discipline rules the
 * operator set for themselves: was reward/risk good enough, did the AI consensus
 * actually support it, was the entry chasing an extended move, was there news
 * risk? Every critique is derived from numbers the engine already has, so the
 * review runs WITHOUT an ANTHROPIC_API_KEY. Claude, when present, adds a short
 * coaching note on top — it never fabricates a critique.
 *
 * This is reflection only: it never places, approves, or modifies a trade.
 */

export interface CoachInput {
  ref: string;
  symbol: string;
  side: "long" | "short";
  entry: number;
  stopLoss: number;
  target: number;
  /** Reward/risk ratio at proposal. */
  rr: number | null;
  /** Avrrio score at proposal, if known. */
  score: number | null;
  consensus?: {
    recommendation: "long" | "short" | "no-trade";
    confidence: number;
    agreement: number;
    available: number;
  } | null;
  news?: { blocked: boolean; reason: string } | null;
  /** True if the operator approved against an unsupportive AI consensus. */
  overrodeConsensus?: boolean;
  thresholds: { minScore: number; minRR: number };
  /** Market structure near entry, for "late/extended entry" detection. */
  structure?: { trend: string; recentHigh: number; recentLow: number; sma: number } | null;
  /** Reference price used to judge how late the entry was (e.g. last price). */
  last?: number | null;
  /** Realized outcome, if the trade has closed. */
  outcome?: { realizedPnl: number | null; paper: boolean } | null;
}

export type CoachGrade = "A" | "B" | "C" | "D";

export interface CoachReview {
  ref: string;
  symbol: string;
  /** What broke discipline, in plain language. */
  critiques: string[];
  /** What the operator did right (reinforcement). */
  wentWell: string[];
  grade: CoachGrade;
  summary: string;
}

/**
 * Produce a post-trade review. Pure: no I/O, no trade side-effects. Missing
 * inputs simply produce fewer observations.
 */
export function coachReview(input: CoachInput): CoachReview {
  const t = input.thresholds;
  const critiques: string[] = [];
  const wentWell: string[] = [];

  // --- Reward/risk discipline ------------------------------------------
  if (typeof input.rr === "number") {
    if (input.rr < t.minRR) {
      critiques.push(`Reward/risk was only ${input.rr.toFixed(1)}:1 — below your ${t.minRR}:1 minimum.`);
    } else {
      wentWell.push(`Reward/risk was sound (${input.rr.toFixed(1)}:1).`);
    }
  }

  // --- Did Avrrio actually endorse it? ---------------------------------
  if (typeof input.score === "number") {
    if (input.score < t.minScore) {
      critiques.push(`Avrrio score was ${input.score}, under your A+ threshold of ${t.minScore} — this wasn't a top-tier setup.`);
    } else {
      wentWell.push(`Avrrio score cleared the bar (${input.score} ≥ ${t.minScore}).`);
    }
  }
  const con = input.consensus ?? null;
  if (con && con.available > 0) {
    if (con.recommendation === "no-trade") {
      critiques.push(`Avrrio's AI consensus said WAIT (no-trade) before entry — you traded anyway.`);
    } else if (con.recommendation !== input.side) {
      critiques.push(`AI consensus leaned ${con.recommendation}, opposite your ${input.side} entry.`);
    } else {
      wentWell.push(`AI consensus backed the ${input.side} (${con.agreement}/${con.available} agree).`);
    }
  }
  if (input.overrodeConsensus) {
    critiques.push("You approved this against the AI consensus (override) — make sure you had a clear reason.");
  }

  // --- Late / extended entry -------------------------------------------
  const s = input.structure ?? null;
  const px = input.last ?? input.entry;
  if (s && s.sma) {
    const ext = (px - s.sma) / s.sma;
    if (input.side === "long") {
      if (ext > 0.004) critiques.push(`Entry looks late — price was ${(ext * 100).toFixed(1)}% above its mean (chasing strength).`);
      if (s.recentHigh && Math.abs(px - s.recentHigh) / s.recentHigh < 0.0015)
        critiques.push("You bought into the session high — little room before resistance.");
    } else {
      if (ext < -0.004) critiques.push(`Entry looks late — price was ${(Math.abs(ext) * 100).toFixed(1)}% below its mean (chasing weakness).`);
      if (s.recentLow && Math.abs(px - s.recentLow) / s.recentLow < 0.0015)
        critiques.push("You sold into the session low — little room before support.");
    }
  }

  // --- News risk --------------------------------------------------------
  if (input.news?.blocked) {
    critiques.push(`There was news risk in play (${input.news.reason || "blackout window"}).`);
  }

  // --- Outcome (only if closed) ----------------------------------------
  if (input.outcome && typeof input.outcome.realizedPnl === "number") {
    const pnl = input.outcome.realizedPnl;
    const tag = input.outcome.paper ? " (paper)" : "";
    if (pnl > 0) wentWell.push(`Result: +$${pnl.toFixed(0)}${tag}.`);
    else if (pnl < 0) critiques.push(`Result: -$${Math.abs(pnl).toFixed(0)}${tag}. Review whether the plan or the execution failed.`);
    else wentWell.push(`Result: scratch${tag}.`);
  }

  const grade = gradeFrom(critiques.length, wentWell.length);
  const summary = render(input, critiques, wentWell, grade);
  return { ref: input.ref, symbol: input.symbol, critiques, wentWell, grade, summary };
}

/** Grade from the balance of discipline breaks vs things done right. */
function gradeFrom(critiqueCount: number, goodCount: number): CoachGrade {
  if (critiqueCount === 0) return "A";
  if (critiqueCount === 1 && goodCount >= 1) return "B";
  if (critiqueCount <= 2) return "C";
  return "D";
}

function render(
  input: CoachInput,
  critiques: string[],
  wentWell: string[],
  grade: CoachGrade,
): string {
  const lines = [
    `🧑‍🏫 TRADE COACH — ${input.ref} ${input.symbol} ${input.side.toUpperCase()}`,
    `Plan: entry ${input.entry} · stop ${input.stopLoss} · target ${input.target}`,
    "",
  ];
  if (wentWell.length) {
    lines.push("What went well:");
    lines.push(...wentWell.map((w) => `• ${w}`));
    lines.push("");
  }
  if (critiques.length) {
    lines.push("What to improve:");
    lines.push(...critiques.map((c) => `• ${c}`));
    lines.push("");
  } else {
    lines.push("No discipline breaks detected — clean execution.");
    lines.push("");
  }
  lines.push(`Discipline grade: ${grade}`);
  lines.push("Advisory reflection only — it does not change or place any trade.");
  return lines.join("\n");
}
