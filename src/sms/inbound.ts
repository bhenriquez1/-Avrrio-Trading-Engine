/**
 * Parser for inbound SMS commands. Beginner-friendly, forgiving of case and
 * extra whitespace. Supports:
 *   YES {ref} / APPROVE {ref}   -> approve
 *   NO {ref}  / REJECT {ref}    -> reject
 *   STOPALL                     -> emergency stop
 *   STATUS                      -> backend + TopstepX status
 *   PENDING                     -> list pending trades
 */
export type SmsCommand =
  | { type: "approve"; ref: string }
  | { type: "reject"; ref: string }
  | { type: "stopall" }
  | { type: "status" }
  | { type: "pending" }
  | { type: "unknown"; raw: string };

export function parseSmsCommand(body: string): SmsCommand {
  const text = body.trim();
  const upper = text.toUpperCase();
  const parts = upper.split(/\s+/);
  const verb = parts[0] ?? "";

  if (verb === "STOPALL" || upper === "STOP ALL") return { type: "stopall" };
  if (verb === "STATUS") return { type: "status" };
  if (verb === "PENDING") return { type: "pending" };

  const ref = parts[1] ? normalizeRef(parts[1]) : "";
  if ((verb === "YES" || verb === "APPROVE") && ref) {
    return { type: "approve", ref };
  }
  if ((verb === "NO" || verb === "REJECT") && ref) {
    return { type: "reject", ref };
  }
  return { type: "unknown", raw: text };
}

/** Accepts "T-1042", "t1042", or "1042" and normalizes to "T-1042". */
export function normalizeRef(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `T-${digits}` : raw.toUpperCase();
}
