import type { SetupDefinition } from "./types.js";

/**
 * The registry of predefined setups. Add new setups here (or load from JSON).
 * Keep them few, specific, and conservative — this is the universe of trades the
 * engine is allowed to consider.
 */
export const SETUPS: SetupDefinition[] = [
  {
    name: "NQ-ORB-Long",
    symbol: "NQ",
    direction: "long",
    entryCondition:
      "Break and hold above the opening-range high (first 15m) on rising volume.",
    stopLossRule: "Below the opening-range low, max 40 points.",
    takeProfitRule: "2R, or prior session high, whichever is nearer.",
    maxRisk: 300,
    allowedHours: "09:30-11:00",
    invalidationRules: [
      "Price re-enters the opening range",
      "High-impact news within 15 minutes",
      "Daily loss limit within one trade of being hit",
    ],
  },
  {
    name: "ES-Trend-Pullback",
    symbol: "ES",
    direction: "both",
    entryCondition:
      "Pullback to the rising/falling 20-period SMA in a clear trend, with rejection.",
    stopLossRule: "Beyond the swing that created the pullback, max 12 points.",
    takeProfitRule: "1.5R minimum.",
    maxRisk: 250,
    allowedHours: "09:30-15:30",
    invalidationRules: [
      "Trend structure breaks (lower-high in uptrend / higher-low in downtrend)",
      "High-impact news within 15 minutes",
    ],
  },
];

export function findSetup(name: string): SetupDefinition | undefined {
  return SETUPS.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

export type { SetupDefinition } from "./types.js";
export { withinAllowedHours } from "./types.js";
