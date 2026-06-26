import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderOpinion } from "../ai/consensus.js";
import type { TradeGradeResult } from "../ai/tradeGrade.js";
import type { ManagementAction } from "../ai/tradeManagement.js";
import type { OrderResult, OrderType, RuleViolation, Side } from "../types.js";

export type RecommendationStatus =
  | "pending" // awaiting operator approval
  | "armed" // pre-approved; waiting for the entry/conditions to trigger
  | "approved" // approved, order in flight / executed
  | "rejected" // operator declined
  | "executed" // order accepted by broker (or paper)
  | "blocked" // risk manager / safety blocked it
  | "expired";

/** How an approved trade should execute. */
export type ApprovalMode = "immediate" | "pre-approved";

/**
 * A trade the engine is proposing. It carries every input to the approval
 * decision: the proposed order, the risk assessment, the AI consensus, and news
 * status. It is only ever executed after explicit approval (or, in
 * semi-autonomous mode, after every auto-gate passes).
 */
export interface Recommendation {
  id: string;
  /** Short human/SMS-friendly reference, e.g. "T-1042". */
  ref: string;
  createdAt: string;
  setupName: string | null;
  symbol: string;
  side: Side;
  size: number;
  entry: number;
  stopLoss: number;
  target: number;
  riskAmount: number;
  rewardRiskRatio: number;
  /** Engine risk approval (no blocking violations). */
  riskApproved: boolean;
  violations: RuleViolation[];
  /** Avrrio Score (0..100) for the symbol at proposal time, or null. */
  avrrioScore: number | null;
  /** Confidence/Grade/Trade-Quality-Score breakdown at proposal time, or null. */
  grade: TradeGradeResult | null;
  /** Auto-selected order type (never defaults to market) and why. */
  orderType: OrderType;
  orderTypeRationale: string;
  consensus: {
    recommendation: Side | "no-trade";
    confidence: number;
    agreement: number;
    available: number;
    opinions: ProviderOpinion[];
  };
  news: { blocked: boolean; reason: string };
  /** True if every semi-autonomous auto-execution gate passed. */
  autoEligible: boolean;
  status: RecommendationStatus;
  /** Unguessable token allowing approve/reject from a notification link. */
  approvalToken: string;
  /** When the recommendation/approval is no longer valid (ISO), or null. */
  expiresAt: string | null;
  /** Set when approved: immediate execution vs pre-approved (wait for entry). */
  approvalMode: ApprovalMode | null;
  decidedBy?: string;
  decidedAt?: string;
  orderResult?: OrderResult;
  /** Most recent Live Trade Management action sent for this open position, if any. */
  lastManagementAction?: ManagementAction;
  /** Set once an exit/closing review has been sent or the operator marks it closed. */
  managementClosedAt?: string;
}

export type NewRecommendation = Omit<
  Recommendation,
  "id" | "ref" | "createdAt" | "status" | "approvalToken"
>;

export class RecommendationStore {
  private items: Recommendation[] = [];

  constructor(private readonly path = "data/recommendations.json") {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      this.items = JSON.parse(raw) as Recommendation[];
    } catch {
      this.items = [];
    }
  }

  list(): readonly Recommendation[] {
    return this.items;
  }

  pending(): Recommendation[] {
    return this.items.filter((r) => r.status === "pending");
  }

  async add(rec: NewRecommendation): Promise<Recommendation> {
    const full: Recommendation = {
      ...rec,
      id: randomUUID(),
      ref: this.nextRef(),
      createdAt: new Date().toISOString(),
      status: rec.riskApproved ? "pending" : "blocked",
      approvalToken: randomBytes(18).toString("hex"),
    };
    this.items.push(full);
    await this.persist();
    return full;
  }

  get(idOrRef: string): Recommendation | undefined {
    return this.items.find((r) => r.id === idOrRef || r.ref === idOrRef);
  }

  /** Case-insensitive lookup by short ref (e.g. "T-1042"). */
  findByRef(ref: string): Recommendation | undefined {
    const key = ref.toUpperCase();
    return this.items.find((r) => r.ref.toUpperCase() === key);
  }

  private nextRef(): string {
    let max = 1041; // first ref will be T-1042
    for (const r of this.items) {
      const n = Number((r.ref ?? "").replace(/[^\d]/g, ""));
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `T-${max + 1}`;
  }

  /** Pre-approved trades waiting for their entry/conditions to trigger. */
  armed(): Recommendation[] {
    return this.items.filter((r) => r.status === "armed");
  }

  /** Executed positions still under active management (not yet closed). */
  openPositions(): Recommendation[] {
    return this.items.filter(
      (r) => r.status === "executed" && !r.managementClosedAt,
    );
  }

  async update(rec: Recommendation): Promise<void> {
    const idx = this.items.findIndex((r) => r.id === rec.id);
    if (idx >= 0) this.items[idx] = rec;
    await this.persist();
  }

  /** Count of executed trades created today (for the per-day cap). */
  executedToday(): number {
    const today = new Date().toISOString().slice(0, 10);
    return this.items.filter(
      (r) => r.status === "executed" && r.createdAt.slice(0, 10) === today,
    ).length;
  }

  hasOpenDuplicate(symbol: string, side: Side): boolean {
    return this.items.some(
      (r) =>
        r.symbol.toUpperCase() === symbol.toUpperCase() &&
        r.side === side &&
        (r.status === "pending" ||
          r.status === "approved" ||
          r.status === "executed"),
    );
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.items, null, 2), "utf8");
  }
}
