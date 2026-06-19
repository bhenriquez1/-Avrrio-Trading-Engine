import type { Recommendation } from "../execution/recommendations.js";
import { findSymbol } from "../symbols/registry.js";

/** The full 🚨 signal SMS with reply instructions. */
export function formatSignalSms(rec: Recommendation): string {
  const riskPts = Math.abs(rec.entry - rec.stopLoss);
  const rewardPts = Math.abs(rec.target - rec.entry);
  const rr = riskPts > 0 ? (rewardPts / riskPts).toFixed(1) : "n/a";
  const assetClass = findSymbol(rec.symbol)?.assetClass ?? "futures";
  return [
    "🚨 Avrrio Trade AI Signal",
    `Trade ID: ${rec.ref}`,
    `Asset: ${assetClass}`,
    `Symbol: ${rec.symbol}`,
    `Side: ${rec.side.toUpperCase()}`,
    `Entry: ${rec.entry}`,
    `Stop: ${rec.stopLoss}`,
    `Target: ${rec.target}`,
    `Size: ${rec.size} contract(s)`,
    `Risk: ${riskPts} pts ($${rec.riskAmount.toFixed(0)})`,
    `Reward: ${rewardPts} pts`,
    `R:R = 1:${rr}`,
    `AI Confidence: ${(rec.consensus.confidence * 100).toFixed(0)}%`,
    `Avrrio Score: ${rec.avrrioScore ?? "n/a"}/100`,
    "",
    `Reply YES ${rec.ref} to approve`,
    `Reply NO ${rec.ref} to reject`,
    "Reply STOPALL for Emergency Stop",
  ].join("\n");
}

/** A high-confidence scanner opportunity alert. */
export function formatOpportunitySms(args: {
  symbol: string;
  name: string;
  direction: string;
  score: number;
  confidence: number;
}): string {
  return [
    "🔥 Avrrio opportunity",
    `${args.symbol} (${args.name}) — ${args.direction}`,
    `Avrrio Score: ${args.score}/100 · Confidence ${(args.confidence * 100).toFixed(0)}%`,
    "Open the dashboard to propose a trade.",
  ].join("\n");
}
