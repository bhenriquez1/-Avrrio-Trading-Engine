import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only audit log (JSON Lines). Every safety-relevant decision —
 * recommendation, risk check, approval, rejection, kill-switch toggle, order
 * result — is recorded here. This file is the system's accountability record.
 */
export interface AuditEvent {
  timestamp: string;
  type: string;
  /** Who/what triggered it: "system", "operator", a setup name, etc. */
  actor: string;
  details: Record<string, unknown>;
}

export class AuditLog {
  constructor(private readonly path = "data/audit.jsonl") {}

  async log(
    type: string,
    actor: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      type,
      actor,
      details,
    };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(event) + "\n", "utf8");
  }

  /** Returns the most recent `limit` events, newest first. */
  async recent(limit = 100): Promise<AuditEvent[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      const events = lines.map((l) => JSON.parse(l) as AuditEvent);
      return events.reverse().slice(0, limit);
    } catch {
      return [];
    }
  }
}
