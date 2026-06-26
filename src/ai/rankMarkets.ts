import type { Direction } from "../scanner/scanner.js";

export interface MarketRank {
  rank: number;
  symbol: string;
  name: string;
  tradable: boolean;
  score: number;
  direction: Direction;
  side: "long" | "short" | null;
  rewardRisk: number | null;
  newsBlocked: boolean;
  duplicateOpen: boolean;
  qualifies: boolean;
  reason: string;
}

export interface RankMarketInput {
  symbol: string;
  name: string;
  tradable: boolean;
  score: number;
  minScore: number;
  direction: Direction;
  newsBlocked: boolean;
  rewardRisk: number | null;
  minRewardRisk: number;
  duplicateOpen: boolean;
}

/** Grades one already-ranked (by score) scan result into a qualify/reason pair. */
export function rankMarket(input: RankMarketInput, rank: number): MarketRank {
  const side: "long" | "short" | null =
    input.direction === "bullish"
      ? "long"
      : input.direction === "bearish"
        ? "short"
        : null;

  let reason = "✅ qualifies — clears every filter.";
  let qualifies = true;
  if (!input.tradable) {
    qualifies = false;
    reason = "Watchlist-only — not tradable as futures.";
  } else if (!side) {
    qualifies = false;
    reason = "No clear directional trend (range/reversal).";
  } else if (input.score < input.minScore) {
    qualifies = false;
    reason = `Avrrio Score ${input.score} below the ${input.minScore} minimum.`;
  } else if (input.newsBlocked) {
    qualifies = false;
    reason = "News risk (blackout window active).";
  } else if (
    input.rewardRisk != null &&
    input.rewardRisk < input.minRewardRisk
  ) {
    qualifies = false;
    reason = `Reward/risk ${input.rewardRisk.toFixed(2)}:1 below the ${input.minRewardRisk}:1 minimum.`;
  } else if (input.duplicateOpen) {
    qualifies = false;
    reason = "Duplicate open position already exists.";
  }

  return {
    rank,
    symbol: input.symbol,
    name: input.name,
    tradable: input.tradable,
    score: input.score,
    direction: input.direction,
    side,
    rewardRisk: input.rewardRisk,
    newsBlocked: input.newsBlocked,
    duplicateOpen: input.duplicateOpen,
    qualifies,
    reason,
  };
}

export function rankMarketsText(ranks: MarketRank[]): string {
  const lines = ["📈 RANKED MARKETS — every symbol, best to worst"];
  for (const r of ranks) {
    const dir =
      r.side === "long" ? "LONG" : r.side === "short" ? "SHORT" : r.direction;
    const rr =
      r.rewardRisk != null ? ` · R:R ${r.rewardRisk.toFixed(2)}:1` : "";
    const flag = r.qualifies ? "✅" : "—";
    lines.push(
      `${r.rank}. ${flag} ${r.symbol} — ${r.score}/100 (${dir})${rr} — ${r.reason}`,
    );
  }
  return lines.join("\n");
}
