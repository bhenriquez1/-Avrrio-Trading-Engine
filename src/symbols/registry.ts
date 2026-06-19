/**
 * Symbol registry with asset classes.
 *
 * Trading policy: only **futures** are tradable through TopstepX. Stocks and
 * crypto are watchlist / analysis-only for now (`tradable: false`). Unknown
 * symbols typed manually are allowed for analysis but are never tradable.
 */
export type AssetClass = "futures" | "stocks" | "crypto";

export interface SymbolInfo {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Whether the engine may place a real order on this symbol. */
  tradable: boolean;
}

function futures(symbol: string, name: string): SymbolInfo {
  return { symbol, name, assetClass: "futures", tradable: true };
}
function watchlist(
  symbol: string,
  name: string,
  assetClass: AssetClass,
): SymbolInfo {
  return { symbol, name, assetClass, tradable: false };
}

export const SYMBOLS: SymbolInfo[] = [
  // --- Futures (tradable via TopstepX) ---
  futures("NQ", "E-mini Nasdaq 100"),
  futures("MNQ", "Micro E-mini Nasdaq 100"),
  futures("ES", "E-mini S&P 500"),
  futures("MES", "Micro E-mini S&P 500"),
  futures("YM", "E-mini Dow"),
  futures("MYM", "Micro E-mini Dow"),
  futures("RTY", "E-mini Russell 2000"),
  futures("M2K", "Micro E-mini Russell 2000"),
  futures("CL", "Crude Oil"),
  futures("MCL", "Micro Crude Oil"),
  futures("GC", "Gold"),
  futures("MGC", "Micro Gold"),
  // --- Stocks (watchlist / analysis only) ---
  watchlist("AAPL", "Apple", "stocks"),
  watchlist("TSLA", "Tesla", "stocks"),
  watchlist("NVDA", "NVIDIA", "stocks"),
  watchlist("AMD", "AMD", "stocks"),
  watchlist("MSFT", "Microsoft", "stocks"),
  watchlist("AMZN", "Amazon", "stocks"),
  watchlist("META", "Meta", "stocks"),
  watchlist("GOOGL", "Alphabet", "stocks"),
  // --- Crypto (watchlist / analysis only) ---
  watchlist("BTCUSD", "Bitcoin", "crypto"),
  watchlist("ETHUSD", "Ethereum", "crypto"),
  watchlist("SOLUSD", "Solana", "crypto"),
];

/** Normalizes a symbol (strips contract month suffixes, uppercases). */
function normalize(symbol: string): string {
  return symbol.toUpperCase().trim();
}

export function findSymbol(symbol: string): SymbolInfo | undefined {
  const key = normalize(symbol);
  return SYMBOLS.find((s) => s.symbol === key);
}

/**
 * Whether a symbol may be traded. Known futures → true; known stocks/crypto →
 * false; unknown (manually entered) → false (analysis only, never tradable).
 */
export function isTradable(symbol: string): boolean {
  return findSymbol(symbol)?.tradable ?? false;
}

export function listByClass(assetClass: AssetClass): SymbolInfo[] {
  return SYMBOLS.filter((s) => s.assetClass === assetClass);
}

export function tradableSymbols(): SymbolInfo[] {
  return SYMBOLS.filter((s) => s.tradable);
}
