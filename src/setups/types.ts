import type { Side } from "../types.js";

/**
 * A predefined trade setup. The engine may only act on setups defined here —
 * the AI cannot invent arbitrary trades. Each setup is a small, auditable
 * specification of when and how a trade is allowed.
 */
export interface SetupDefinition {
  /** Unique, human-readable name (e.g. "NQ-ORB-Long"). */
  name: string;
  symbol: string;
  /** Allowed direction(s) for this setup. */
  direction: Side | "both";
  /** Plain-language entry condition (evaluated by the AI / operator). */
  entryCondition: string;
  /** How the stop is derived (points, structure, etc.). */
  stopLossRule: string;
  /** How the target is derived. */
  takeProfitRule: string;
  /** Hard cap on dollar risk for trades from this setup. */
  maxRisk: number;
  /** Allowed trading window, local exchange time, 24h "HH:MM-HH:MM". */
  allowedHours: string;
  /** Conditions that invalidate the setup (no trade). */
  invalidationRules: string[];
}

/** Returns true if `now` falls inside the setup's allowed "HH:MM-HH:MM" window. */
export function withinAllowedHours(
  setup: SetupDefinition,
  now = new Date(),
): boolean {
  const match = setup.allowedHours.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return true; // unspecified window = always allowed
  const [, sh, sm, eh, em] = match;
  const start = Number(sh) * 60 + Number(sm);
  const end = Number(eh) * 60 + Number(em);
  const cur = now.getHours() * 60 + now.getMinutes();
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
}
