/**
 * Detects which known symbols and "my position(s)" intent a free-form Telegram
 * message refers to, so the assistant can answer naturally about a specific
 * market or open trade without requiring rigid "/discuss T-1042" syntax.
 */

/** Returns the known symbols mentioned in text, as whole words, de-duplicated. */
export function extractMentionedSymbols(
  text: string,
  knownSymbols: readonly string[],
): string[] {
  const upper = text.toUpperCase();
  const found = new Set<string>();
  for (const symbol of knownSymbols) {
    const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    if (re.test(upper)) found.add(symbol);
  }
  return [...found];
}

/** Whether the message is asking about open position(s)/trade(s) generically. */
export function mentionsOpenPositions(text: string): boolean {
  return /\b(my|the)\s+(position|positions|trade|trades|holding|holdings)\b/i.test(
    text,
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
