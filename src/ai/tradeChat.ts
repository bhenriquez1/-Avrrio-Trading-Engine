import type { Recommendation } from "../execution/recommendations.js";

/**
 * Deterministic per-trade conversation + "What if?" support.
 *
 * Everything here is pure math and string assembly — it runs WITHOUT an
 * ANTHROPIC_API_KEY. Claude (when configured) only adds prose on top of these
 * numbers; it never changes them. None of this places, approves, or modifies a
 * trade — it is advisory analysis only.
 */

/** A single trade-parameter override parsed from a natural-language scenario. */
export interface ScenarioChanges {
  entry?: number;
  stopLoss?: number;
  target?: number;
  size?: number;
  /** Assumed win probability (0..1) for the expectancy calc, if asked. */
  winRate?: number;
}

/** The recomputed risk/reward picture for a (possibly adjusted) trade. */
export interface Leg {
  entry: number;
  stopLoss: number;
  target: number;
  size: number;
  /** Reward-to-risk ratio (target distance / stop distance). */
  rr: number;
  /** Dollar risk if the stop is hit, or null when it can't be derived. */
  riskAmount: number | null;
  /** Dollar reward if the target is hit, or null when it can't be derived. */
  rewardAmount: number | null;
}

export interface WhatIfResult {
  ref: string;
  symbol: string;
  side: string;
  scenario: string;
  base: Leg;
  adjusted: Leg;
  /** Plain-language list of what changed between base and adjusted. */
  changes: string[];
  /** Expectancy per trade in dollars at the assumed win rate, or null. */
  expectancy: { winRate: number; value: number } | null;
  /** A deterministic, secret-free summary line (works with no AI key). */
  summary: string;
}

function rr(entry: number, stopLoss: number, target: number): number {
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return 0;
  return Math.abs(target - entry) / risk;
}

/**
 * Dollars of P&L per point, per contract, implied by the recommendation's own
 * risk figure. Lets "what if" scale risk/reward to any new stop/target/size
 * without needing a contract-spec table.
 */
function dollarsPerPointPerContract(rec: Recommendation): number | null {
  const pointRisk = Math.abs(rec.entry - rec.stopLoss);
  if (pointRisk <= 0 || rec.size <= 0 || rec.riskAmount <= 0) return null;
  return rec.riskAmount / (pointRisk * rec.size);
}

function leg(
  entry: number,
  stopLoss: number,
  target: number,
  size: number,
  dpp: number | null,
): Leg {
  const ratio = rr(entry, stopLoss, target);
  const riskPoints = Math.abs(entry - stopLoss);
  const rewardPoints = Math.abs(target - entry);
  return {
    entry: round(entry),
    stopLoss: round(stopLoss),
    target: round(target),
    size,
    rr: Number(ratio.toFixed(2)),
    riskAmount: dpp != null ? round(riskPoints * size * dpp) : null,
    rewardAmount: dpp != null ? round(rewardPoints * size * dpp) : null,
  };
}

/**
 * Parse a free-form scenario into concrete parameter overrides. Conservative by
 * design: only acts on patterns it recognises, ignores the rest.
 *
 * Examples it understands:
 *   "what if I move my stop to 20010"
 *   "target 20120"  ·  "entry at 20005"
 *   "what if I only use one contract"  ·  "size 3"  ·  "2 contracts"
 *   "what if my win rate is 40%"
 */
export function parseScenario(scenario: string): ScenarioChanges {
  const s = scenario.toLowerCase();
  const changes: ScenarioChanges = {};

  const numAfter = (label: RegExp): number | undefined => {
    const m = s.match(label);
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : undefined;
  };

  const stopLoss = numAfter(/stop(?:\s*loss)?\s*(?:to|at|=|:)?\s*\$?(\d+(?:\.\d+)?)/);
  if (stopLoss !== undefined) changes.stopLoss = stopLoss;
  const target = numAfter(/target\s*(?:to|at|=|:)?\s*\$?(\d+(?:\.\d+)?)/);
  if (target !== undefined) changes.target = target;
  const entry = numAfter(/entry\s*(?:to|at|=|:)?\s*\$?(\d+(?:\.\d+)?)/);
  if (entry !== undefined) changes.entry = entry;

  // Position size: "one/two/three contract(s)", "size N", or "N contracts".
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const wordSize = s.match(/\b(one|two|three|four|five)\s+contract/);
  if (wordSize && words[wordSize[1] as string] !== undefined) {
    changes.size = words[wordSize[1] as string];
  } else {
    const sizeM = numAfter(/\bsize\s*(?:to|=|:)?\s*(\d+)/) ?? numAfter(/\b(\d+)\s*contracts?\b/);
    if (sizeM !== undefined) changes.size = Math.max(1, Math.round(sizeM));
  }

  // Win rate for expectancy: if the scenario mentions "win", take the first %.
  if (/win/.test(s)) {
    const wr = numAfter(/(\d+(?:\.\d+)?)\s*%/);
    if (wr !== undefined && wr > 0 && wr <= 100) changes.winRate = wr / 100;
  }

  return changes;
}

/**
 * Recompute risk/reward (and optionally expectancy) for a recommendation under a
 * scenario. Pure: no I/O, no trade side-effects. If the scenario changes nothing
 * recognisable, `adjusted` equals `base`.
 */
export function computeWhatIf(rec: Recommendation, scenario: string): WhatIfResult {
  const dpp = dollarsPerPointPerContract(rec);
  const c = parseScenario(scenario);

  const entry = c.entry ?? rec.entry;
  const stopLoss = c.stopLoss ?? rec.stopLoss;
  const target = c.target ?? rec.target;
  const size = c.size ?? rec.size;

  const base = leg(rec.entry, rec.stopLoss, rec.target, rec.size, dpp);
  const adjusted = leg(entry, stopLoss, target, size, dpp);

  const changes: string[] = [];
  if (c.entry !== undefined && c.entry !== rec.entry)
    changes.push(`entry ${rec.entry} → ${round(c.entry)}`);
  if (c.stopLoss !== undefined && c.stopLoss !== rec.stopLoss)
    changes.push(`stop ${rec.stopLoss} → ${round(c.stopLoss)}`);
  if (c.target !== undefined && c.target !== rec.target)
    changes.push(`target ${rec.target} → ${round(c.target)}`);
  if (c.size !== undefined && c.size !== rec.size)
    changes.push(`size ${rec.size} → ${c.size} contract${c.size === 1 ? "" : "s"}`);

  // Expectancy: use the asked win rate, else fall back to the AI consensus
  // confidence as a rough prior. Always shown as "assumed", never a promise.
  const winRate = c.winRate ?? clamp01(rec.consensus?.confidence ?? 0);
  let expectancy: WhatIfResult["expectancy"] = null;
  if (winRate > 0 && adjusted.riskAmount != null && adjusted.rewardAmount != null) {
    const value = winRate * adjusted.rewardAmount - (1 - winRate) * adjusted.riskAmount;
    expectancy = { winRate: Number(winRate.toFixed(2)), value: round(value) };
  }

  const summary = buildSummary(rec, base, adjusted, changes, expectancy);
  return {
    ref: rec.ref,
    symbol: rec.symbol,
    side: rec.side,
    scenario,
    base,
    adjusted,
    changes,
    expectancy,
    summary,
  };
}

function money(n: number | null): string {
  return n == null ? "n/a" : `$${n.toFixed(0)}`;
}

function buildSummary(
  rec: Recommendation,
  base: Leg,
  adjusted: Leg,
  changes: string[],
  expectancy: WhatIfResult["expectancy"],
): string {
  if (changes.length === 0) {
    const lines = [
      `${rec.ref} ${rec.symbol} ${rec.side.toUpperCase()} — no recognised change in that scenario.`,
      `Current: entry ${base.entry} · stop ${base.stopLoss} · target ${base.target} · R:R ${base.rr.toFixed(2)} · risk ${money(base.riskAmount)} · reward ${money(base.rewardAmount)}.`,
      `Try e.g. "move stop to ${base.stopLoss}", "target ${base.target}", or "only one contract".`,
    ];
    return lines.join("\n");
  }
  const lines = [
    `${rec.ref} ${rec.symbol} ${rec.side.toUpperCase()} — what-if: ${changes.join(", ")}.`,
    `Before: R:R ${base.rr.toFixed(2)} · risk ${money(base.riskAmount)} · reward ${money(base.rewardAmount)} · ×${base.size}.`,
    `After:  R:R ${adjusted.rr.toFixed(2)} · risk ${money(adjusted.riskAmount)} · reward ${money(adjusted.rewardAmount)} · ×${adjusted.size}.`,
  ];
  const drr = adjusted.rr - base.rr;
  if (Math.abs(drr) >= 0.01) {
    lines.push(`Reward/risk ${drr > 0 ? "improves" : "worsens"} by ${Math.abs(drr).toFixed(2)} (${base.rr.toFixed(2)} → ${adjusted.rr.toFixed(2)}).`);
  }
  if (expectancy) {
    lines.push(
      `Expectancy at ${(expectancy.winRate * 100).toFixed(0)}% assumed win rate: ${money(expectancy.value)} per trade.`,
    );
  }
  lines.push("Advisory only — this does not change the live trade; adjust it yourself in TopstepX if you act.");
  return lines.join("\n");
}

/**
 * Assemble a secret-free context block describing one recommendation, for a
 * Claude follow-up question. No tokens, keys, or account numbers.
 */
export function buildTradeContext(rec: Recommendation): string {
  const riskPts = Math.abs(rec.entry - rec.stopLoss);
  const rewardPts = Math.abs(rec.target - rec.entry);
  const ops = (rec.consensus?.opinions ?? [])
    .map((o) => `${o.provider}=${o.recommendation}${o.available ? ` ${(o.confidence * 100).toFixed(0)}%` : " (n/a)"}`)
    .join(", ");
  return [
    "You are discussing ONE specific trade recommendation with the operator. Use only these facts.",
    `Ref: ${rec.ref} · Symbol: ${rec.symbol} · Side: ${rec.side.toUpperCase()} · Size: ${rec.size} · Status: ${rec.status}`,
    `Setup: ${rec.setupName ?? "n/a"}`,
    `Entry: ${rec.entry} · Stop: ${rec.stopLoss} · Target: ${rec.target}`,
    `Risk distance: ${round(riskPts)} pts · Reward distance: ${round(rewardPts)} pts · Reward/Risk: ${rec.rewardRiskRatio.toFixed(2)} · Dollar risk: $${rec.riskAmount.toFixed(0)}`,
    `Avrrio score: ${rec.avrrioScore ?? "n/a"}`,
    `AI consensus: ${rec.consensus?.recommendation ?? "n/a"} (${rec.consensus?.agreement ?? 0}/${rec.consensus?.available ?? 0} agree, ${((rec.consensus?.confidence ?? 0) * 100).toFixed(0)}% confidence)${ops ? ` — ${ops}` : ""}`,
    `News: ${rec.news?.blocked ? `BLOCKED — ${rec.news.reason}` : "clear"}`,
    rec.violations?.length
      ? `Risk violations: ${rec.violations.map((v) => `[${v.severity}] ${v.message}`).join("; ")}`
      : "Risk violations: none",
    "You are ADVISORY ONLY: you cannot place, approve, modify, or cancel this trade. The operator must approve via the dashboard or Telegram buttons.",
  ].join("\n");
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
