import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProviderOpinion } from "../ai/consensus.js";
import type { OrderResult, RuleViolation, Side } from "../types.js";

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
}

export type NewRecommendation = Omit<
  Recommendation,
  "id" | "createdAt" | "status" | "approvalToken"
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

  get(id: string): Recommendation | undefined {
    return this.items.find((r) => r.id === id);
  }

  pending(): Recommendation[] {
    return this.items.filter((r) => r.status === "pending");
  }

  async add(rec: NewRecommendation): Promise<Recommendation> {
    const full: Recommendation = {
      ...rec,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: rec.riskApproved ? "pending" : "blocked",
      approvalToken: randomBytes(18).toString("hex"),
    };
    this.items.push(full);
    await this.persist();
    return full;
  }

  /** Pre-approved trades waiting for their entry/conditions to trigger. */
  armed(): Recommendation[] {
    return this.items.filter((r) => r.status === "armed");
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
        (r.status === "pending" || r.status === "approved" || r.status === "executed"),
    );
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.items, null, 2), "utf8");
  }
}
