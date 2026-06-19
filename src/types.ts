/**
 * Shared domain types for the Avrrio Trading Engine.
 *
 * These are intentionally provider-agnostic. The TopstepX/ProjectX client maps
 * raw API payloads into these shapes so the rest of the engine never depends on
 * the wire format.
 */

export type Side = "long" | "short";

export interface AccountSummary {
  id: string;
  name: string;
  balance: number;
  /** Current realized + unrealized P&L for the trading day. */
  dayPnl: number;
  /** Topstep-style account rules, when the API exposes them. */
  rules: AccountRules;
}

export interface AccountRules {
  /** Maximum loss allowed in a single day before the account is locked. */
  maxDailyLoss: number;
  /** Trailing/overall max drawdown from the account high-water mark. */
  maxDrawdown: number;
  /** Largest position size (contracts) the account is allowed to hold. */
  maxPositionSize: number;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  timestamp: string;
}

/** A single OHLCV bar. */
export interface Bar {
  symbol: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A proposed trade the operator (or Claude) is considering. This is the input
 * to the risk manager — it is never sent anywhere.
 */
export interface TradeIdea {
  symbol: string;
  side: Side;
  /** Number of contracts. */
  size: number;
  entry: number;
  stopLoss: number;
  target: number;
  rationale?: string;
}

/** A recorded paper trade in the journal. */
export interface JournalEntry extends TradeIdea {
  id: string;
  createdAt: string;
  /** "idea" until acted on, then "open"/"closed" for paper tracking. */
  status: "idea" | "open" | "closed";
  exit?: number;
  realizedPnl?: number;
  /** Whether the risk manager approved this idea at journaling time. */
  riskApproved: boolean;
}

export interface RuleViolation {
  rule: string;
  message: string;
  severity: "warn" | "block";
}

export interface RiskAssessment {
  approved: boolean;
  /** Risk in account currency: (entry - stop) * size * pointValue (approx). */
  riskAmount: number;
  /** Reward/risk ratio derived from target vs stop. */
  rewardRiskRatio: number;
  violations: RuleViolation[];
}

export interface TopstepStatus {
  connected: boolean;
  authenticated: boolean;
  /** True when running on demo data (no real credentials). */
  offline: boolean;
  accountId: string;
  accountStatus: "active" | "inactive" | "unknown";
  availableBuyingPower: number;
  dailyPnL: number;
  maxDailyLoss: number;
  openPositions: number;
  lastSyncTime: string | null;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  size: number;
  entry: number;
  stopLoss: number;
  target: number;
}

export interface OrderResult {
  accepted: boolean;
  /** Broker order id, or a simulated id in paper mode. */
  orderId: string;
  /** True when this was a paper (non-live) fill. */
  paper: boolean;
  message: string;
}

export interface ClaudeAnalysis {
  recommendation: Side | "no-trade";
  confidence: number; // 0..1
  stopLoss?: number;
  target?: number;
  summary: string;
  /** True when the response came from the model, false for the offline stub. */
  fromModel: boolean;
}
