import type { ScoreComponents } from "../scanner/scanner.js";

/**
 * Debate Mode — deterministic Bull Case / Bear Case / Final Verdict.
 *
 * The point is to teach the operator HOW to think about a setup, not just hand
 * down a yes/no. Every bullet is derived from the same numbers the engine
 * already trusts (Avrrio score components, structure, reward/risk, AI
 * consensus, news), so the debate is consistent with the engine's posture and
 * works WITHOUT an ANTHROPIC_API_KEY. Claude, when present, only rewrites these
 * points in prose — it never changes the verdict or invents evidence.
 *
 * This is advisory analysis only: nothing here places, approves, or modifies a
 * trade.
 */

export type DebateVerdict = "long" | "short" | "wait";

export interface DebateInput {
  symbol: string;
  /** The side under consideration, if any (a recommendation's side). */
  side?: "long" | "short" | null;
  /** Avrrio score 0..100, if known. */
  score?: number | null;
  /** Reward/risk ratio, if known. */
  rr?: number | null;
  /** AI consensus, if available. */
  consensus?: {
    recommendation: "long" | "short" | "no-trade";
    confidence: number;
    agreement: number;
    available: number;
  } | null;
  news?: { blocked: boolean; reason: string } | null;
  /** Avrrio score components (trend/volume/news/momentum/risk), if known. */
  components?: Partial<ScoreComponents> | null;
  /** Market structure context, if known. */
  structure?: {
    trend: string;
    recentHigh: number;
    recentLow: number;
    sma: number;
  } | null;
  /** Last traded price, if known. */
  last?: number | null;
  /** Decision thresholds (defaults mirror the scanner). */
  thresholds?: { minScore: number; minRR: number };
}

export interface DebateResult {
  symbol: string;
  bullCase: string[];
  bearCase: string[];
  verdict: DebateVerdict;
  /** 0..1 conviction in the verdict (not a probability of profit). */
  confidence: number;
  summary: string;
}

const DEFAULTS = { minScore: 85, minRR: 2 } as const;

/**
 * Build a structured debate from whatever facts are available. Pure: no I/O, no
 * trade side-effects. Missing inputs simply produce fewer bullet points.
 */
export function buildDebate(input: DebateInput): DebateResult {
  const t = input.thresholds ?? DEFAULTS;
  const c = input.components ?? {};
  const s = input.structure ?? null;
  const last = input.last ?? s?.sma ?? null;
  const bull: string[] = [];
  const bear: string[] = [];

  // --- Trend / structure ------------------------------------------------
  if (typeof c.trend === "number") {
    if (c.trend >= 70) bull.push(`Trend is strong (trend score ${c.trend}/100).`);
    else if (c.trend <= 40) bear.push(`Trend is weak/unclear (trend score ${c.trend}/100).`);
  }
  if (s) {
    if (s.trend === "up") bull.push("Structure is making higher highs (uptrend).");
    else if (s.trend === "down") bear.push("Structure is making lower lows (downtrend).");
    else bear.push("Structure is sideways — no clear directional edge.");

    if (last != null && s.sma) {
      const ext = (last - s.sma) / s.sma;
      if (ext > 0.004) bear.push(`Price is extended ${(ext * 100).toFixed(1)}% above its mean (${s.sma.toFixed(2)}) — chasing risk.`);
      else if (ext < -0.004) bear.push(`Price is extended ${(Math.abs(ext) * 100).toFixed(1)}% below its mean — falling-knife risk.`);
      else bull.push("Price is near its mean — not extended.");
    }
    if (last != null) {
      const nearHigh = s.recentHigh && Math.abs(last - s.recentHigh) / s.recentHigh < 0.0015;
      const nearLow = s.recentLow && Math.abs(last - s.recentLow) / s.recentLow < 0.0015;
      if (nearHigh) bear.push(`Trading into resistance (near session high ${s.recentHigh}).`);
      if (nearLow) bear.push(`Trading into support (near session low ${s.recentLow}).`);
    }
  }

  // --- Momentum / volume ------------------------------------------------
  if (typeof c.momentum === "number") {
    if (c.momentum >= 70) bull.push(`Momentum is supportive (${c.momentum}/100).`);
    else if (c.momentum <= 40) bear.push(`Momentum is slowing (${c.momentum}/100).`);
  }
  if (typeof c.volume === "number") {
    if (c.volume >= 65) bull.push(`Participation is healthy (volume ${c.volume}/100).`);
    else if (c.volume <= 40) bear.push(`Volume is thin (${c.volume}/100) — moves may not hold.`);
  }

  // --- Reward / risk ----------------------------------------------------
  if (typeof input.rr === "number") {
    if (input.rr >= t.minRR) bull.push(`Reward/risk is favorable (${input.rr.toFixed(1)}:1).`);
    else bear.push(`Reward/risk is poor (${input.rr.toFixed(1)}:1, below ${t.minRR}:1).`);
  }

  // --- Avrrio score -----------------------------------------------------
  if (typeof input.score === "number") {
    if (input.score >= t.minScore) bull.push(`Avrrio score clears the bar (${input.score} ≥ ${t.minScore}).`);
    else bear.push(`Avrrio score below the bar (${input.score} < ${t.minScore}).`);
  }

  // --- AI consensus -----------------------------------------------------
  const con = input.consensus ?? null;
  if (con && con.available > 0) {
    const pct = (con.confidence * 100).toFixed(0);
    if (con.recommendation === "long") bull.push(`AI consensus leans long (${con.agreement}/${con.available} agree, ${pct}%).`);
    else if (con.recommendation === "short") bear.push(`AI consensus leans short (${con.agreement}/${con.available} agree, ${pct}%).`);
    else bear.push(`AI consensus says no-trade (${con.agreement}/${con.available}, ${pct}%).`);
  }

  // --- News -------------------------------------------------------------
  if (input.news?.blocked) bear.push(`News risk: ${input.news.reason || "blackout window"}.`);
  else if (input.news) bull.push("No news blackout in effect.");

  if (bull.length === 0) bull.push("No clearly bullish evidence in the current data.");
  if (bear.length === 0) bear.push("No clearly bearish evidence in the current data.");

  const { verdict, confidence } = decide(input, bull, bear, t);
  const summary = render(input.symbol, bull, bear, verdict, confidence);
  return { symbol: input.symbol, bullCase: bull, bearCase: bear, verdict, confidence, summary };
}

/**
 * Decide the verdict from the same gates the engine enforces, so the debate
 * never contradicts what the engine would actually do:
 *  - News blackout or poor reward/risk → WAIT (hard).
 *  - Otherwise follow AI consensus when available, else the score's direction.
 */
function decide(
  input: DebateInput,
  bull: string[],
  bear: string[],
  t: { minScore: number; minRR: number },
): { verdict: DebateVerdict; confidence: number } {
  // Hard "wait" gates — these mirror the scanner's blocking filters.
  if (input.news?.blocked) {
    return { verdict: "wait", confidence: clamp01(0.8) };
  }
  if (typeof input.rr === "number" && input.rr < t.minRR) {
    const conviction = 0.55 + Math.min(0.3, (t.minRR - input.rr) / t.minRR);
    return { verdict: "wait", confidence: round2(clamp01(conviction)) };
  }

  const con = input.consensus ?? null;
  let verdict: DebateVerdict = "wait";
  let base: number;

  if (con && con.available > 0 && con.recommendation !== "no-trade") {
    verdict = con.recommendation;
    base = con.confidence;
  } else if (con && con.available > 0 && con.recommendation === "no-trade") {
    verdict = "wait";
    base = con.confidence;
  } else if (typeof input.score === "number" && input.score >= t.minScore && input.side) {
    // No consensus available: fall back to a strong score + a known side.
    verdict = input.side;
    base = input.score / 100;
  } else {
    verdict = "wait";
    base = typeof input.score === "number" ? 1 - input.score / 100 : 0.5;
  }

  // Blend evidence balance into conviction so a lopsided case reads as such.
  const balance = (Math.max(bull.length, bear.length) - Math.min(bull.length, bear.length)) /
    Math.max(1, bull.length + bear.length);
  const confidence = round2(clamp01(0.5 * base + 0.5 * (0.5 + balance / 2)));
  return { verdict, confidence };
}

function render(
  symbol: string,
  bull: string[],
  bear: string[],
  verdict: DebateVerdict,
  confidence: number,
): string {
  const label = verdict === "wait" ? "🟡 WAIT" : verdict === "long" ? "🟢 LONG" : "🔴 SHORT";
  return [
    `⚖️ DEBATE — ${symbol}`,
    "",
    "Bull case:",
    ...bull.map((b) => `• ${b}`),
    "",
    "Bear case:",
    ...bear.map((b) => `• ${b}`),
    "",
    `Final verdict: ${label}  ·  confidence ${(confidence * 100).toFixed(0)}%`,
    "Advisory only — teaches the reasoning; it does not place or approve a trade.",
  ].join("\n");
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
