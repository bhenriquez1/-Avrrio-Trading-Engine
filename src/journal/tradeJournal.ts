import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { JournalEntry, TradeIdea } from "../types.js";

/**
 * A simple file-backed paper-trade journal. JSON on disk, loaded into memory.
 *
 * The journal records ideas and their risk-approval state. It is the audit log
 * of the system — what was considered, what was blocked, and (for paper trades)
 * how it would have turned out.
 */
export class TradeJournal {
  private entries: JournalEntry[] = [];

  constructor(private readonly path = "data/journal.json") {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      this.entries = JSON.parse(raw) as JournalEntry[];
    } catch {
      this.entries = [];
    }
  }

  list(): readonly JournalEntry[] {
    return this.entries;
  }

  async record(idea: TradeIdea, riskApproved: boolean): Promise<JournalEntry> {
    const entry: JournalEntry = {
      ...idea,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      status: "idea",
      riskApproved,
    };
    this.entries.push(entry);
    await this.persist();
    return entry;
  }

  /** Records a paper exit and computes realized P&L (points only, no fees). */
  async close(id: string, exit: number, pointVal: number): Promise<JournalEntry> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error(`Journal entry ${id} not found.`);
    const direction = entry.side === "long" ? 1 : -1;
    entry.exit = exit;
    entry.realizedPnl = (exit - entry.entry) * direction * entry.size * pointVal;
    entry.status = "closed";
    await this.persist();
    return entry;
  }

  stats(): { total: number; approved: number; blocked: number; realizedPnl: number } {
    const realizedPnl = this.entries.reduce(
      (sum, e) => sum + (e.realizedPnl ?? 0),
      0,
    );
    return {
      total: this.entries.length,
      approved: this.entries.filter((e) => e.riskApproved).length,
      blocked: this.entries.filter((e) => !e.riskApproved).length,
      realizedPnl,
    };
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.entries, null, 2), "utf8");
  }
}
