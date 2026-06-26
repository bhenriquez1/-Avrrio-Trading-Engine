import type { Direction, ScoreComponents } from "../scanner/scanner.js";
import type { Side } from "../types.js";

export interface ComponentNote {
  label: string;
  value: number;
  note: string;
}

export interface SymbolExplanation {
  symbol: string;
  tradable: boolean;
  score: number;
  minScore: number;
  direction: Direction;
  side: Side | null;
  components: ScoreComponents;
  componentNotes: ComponentNote[];
  newsBlocked: boolean;
  newsReason: string;
  rewardRisk: number | null;
  minRewardRisk: number;
  duplicateOpen: boolean;
  /** True only when every filter currently clears — same bar the scheduler uses to alert. */
  qualifies: boolean;
  /** Plain-language reasons this setup is not alert-worthy right now. */
  blockers: string[];
}

export interface ExplainSymbolInput {
  symbol: string;
  tradable: boolean;
  score: number;
  minScore: number;
  components: ScoreComponents;
  direction: Direction;
  newsBlocked: boolean;
  newsReason: string;
  rewardRisk: number | null;
  minRewardRisk: number;
  duplicateOpen: boolean;
}

/**
 * Builds a full per-component explanation for one symbol — richer than the
 * scheduler's near-miss summary (which only covers the top 3 setups per
 * scan): this works for any symbol on demand, including ones that never made
 * the near-miss list. Read-only — never proposes or alters a trade.
 */
export function explainSymbol(input: ExplainSymbolInput): SymbolExplanation {
  const side: Side | null =
    input.direction === "bullish"
      ? "long"
      : input.direction === "bearish"
        ? "short"
        : null;

  const blockers: string[] = [];
  if (!input.tradable) {
    blockers.push(
      "Watchlist-only symbol — analysis only, not tradable as futures.",
    );
  }
  if (input.score < input.minScore) {
    blockers.push(
      `Avrrio Score ${input.score} is below the ${input.minScore} minimum required to alert.`,
    );
  }
  if (!side) {
    blockers.push(
      "No clear directional trend (range/reversal) — needs a confirmed up/down trend to pick a side.",
    );
  }
  if (input.newsBlocked) {
    blockers.push(
      `News risk: ${input.newsReason || "blackout window active"}.`,
    );
  }
  if (input.rewardRisk != null && input.rewardRisk < input.minRewardRisk) {
    blockers.push(
      `Reward/risk ${input.rewardRisk.toFixed(2)}:1 is below the ${input.minRewardRisk}:1 minimum.`,
    );
  }
  if (input.duplicateOpen) {
    blockers.push(
      "An open position already exists for this symbol/side — no duplicate adds.",
    );
  }

  return {
    symbol: input.symbol,
    tradable: input.tradable,
    score: input.score,
    minScore: input.minScore,
    direction: input.direction,
    side,
    components: input.components,
    componentNotes: buildComponentNotes(input.components),
    newsBlocked: input.newsBlocked,
    newsReason: input.newsReason,
    rewardRisk: input.rewardRisk,
    minRewardRisk: input.minRewardRisk,
    duplicateOpen: input.duplicateOpen,
    qualifies: blockers.length === 0,
    blockers,
  };
}

function buildComponentNotes(c: ScoreComponents): ComponentNote[] {
  const notes: ComponentNote[] = [
    {
      label: "Trend",
      value: Math.round(c.trend),
      note:
        c.trend >= 70
          ? "Strong, clear directional move."
          : c.trend >= 40
            ? "Mild trend — not decisively one direction."
            : "Flat/choppy — no real trend to trade.",
    },
    {
      label: "Momentum",
      value: Math.round(c.momentum),
      note:
        c.momentum >= 70
          ? "Price is stretched well away from its average — strong push."
          : c.momentum >= 40
            ? "Some separation from the average."
            : "Price is hugging its average — little momentum.",
    },
    {
      label: "Volume",
      value: Math.round(c.volume),
      note:
        c.volume >= 70
          ? "Recent volume well above average — real participation."
          : c.volume >= 40
            ? "Volume roughly in line with average."
            : "Volume is light — move isn't well-supported.",
    },
    {
      label: "Risk",
      value: Math.round(c.risk),
      note:
        c.risk >= 70
          ? "Volatility is controlled/calm."
          : c.risk >= 40
            ? "Moderate volatility."
            : "Volatility is elevated — wider, less predictable swings.",
    },
    {
      label: "News",
      value: Math.round(c.news),
      note:
        c.news >= 70
          ? "No high-impact news nearby."
          : "High-impact news risk nearby.",
    },
  ];
  if (c.structure != null) {
    notes.push({
      label: "Structure",
      value: Math.round(c.structure),
      note:
        c.structure >= 70
          ? "Price action is clean and confirms the trend."
          : c.structure >= 40
            ? "Structure is mixed."
            : "Choppy structure — trend isn't confirmed by price action.",
    });
  }
  return notes;
}

export function explainSymbolText(e: SymbolExplanation): string {
  const lines = [
    `🔎 WHY — ${e.symbol}`,
    `Avrrio Score: ${e.score}/100 (need ≥ ${e.minScore}) · Direction: ${e.direction}${e.side ? ` (${e.side})` : ""}`,
  ];
  for (const n of e.componentNotes) {
    lines.push(`• ${n.label} ${n.value}/100 — ${n.note}`);
  }
  if (e.rewardRisk != null) {
    lines.push(
      `Reward/Risk: ${e.rewardRisk.toFixed(2)}:1 (need ≥ ${e.minRewardRisk}:1)`,
    );
  }
  lines.push("");
  if (e.qualifies) {
    lines.push("✅ This setup currently clears every filter.");
  } else {
    lines.push("Blocking this setup right now:");
    for (const b of e.blockers) lines.push(`• ${b}`);
  }
  return lines.join("\n");
}
