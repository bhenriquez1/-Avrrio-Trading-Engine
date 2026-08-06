/**
 * Symbol registry with asset classes.
 *
 * Trading policy:
 *   - Futures are tradable through TopstepX.
 *   - Crypto with a Coinbase product ID are tradable through Coinbase Advanced
 *     when COINBASE_TRADING_ENABLED=true.
 *   - Stocks are watchlist / analysis-only.
 */
export type AssetClass = "futures" | "stocks" | "crypto";
export type Broker = "topstep" | "coinbase" | null;

export interface SymbolInfo {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  /** Whether the engine may place a real order on this symbol. */
  tradable: boolean;
  /** Which broker/exchange handles this symbol's orders. */
  broker: Broker;
  /** For crypto: the Coinbase product ID (e.g. "BTC-USD"). */
  coinbaseProductId?: string;
  /** Approximate minimum tick size for display rounding. */
  tickSize?: number;
}

function futures(symbol: string, name: string): SymbolInfo {
  return {
    symbol,
    name,
    assetClass: "futures",
    tradable: true,
    broker: "topstep",
  };
}
function watchlist(
  symbol: string,
  name: string,
  assetClass: AssetClass,
): SymbolInfo {
  return { symbol, name, assetClass, tradable: false, broker: null };
}
function crypto(
  symbol: string,
  name: string,
  coinbaseProductId: string,
  tickSize = 0.01,
): SymbolInfo {
  return {
    symbol,
    name,
    assetClass: "crypto",
    tradable: true,
    broker: "coinbase",
    coinbaseProductId,
    tickSize,
  };
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
  futures("PL", "Platinum"),
  futures("HG", "Copper"),
  futures("ZC", "Corn"),
  futures("ZW", "Wheat"),
  futures("ZS", "Soybeans"),
  // --- Stocks (watchlist / analysis only) ---
  watchlist("AAPL", "Apple", "stocks"),
  watchlist("TSLA", "Tesla", "stocks"),
  watchlist("NVDA", "NVIDIA", "stocks"),
  watchlist("AMD", "AMD", "stocks"),
  watchlist("MSFT", "Microsoft", "stocks"),
  watchlist("AMZN", "Amazon", "stocks"),
  watchlist("META", "Meta", "stocks"),
  watchlist("GOOGL", "Alphabet", "stocks"),
  // --- Crypto (tradable via Coinbase when enabled) ---
  crypto("BTCUSD", "Bitcoin", "BTC-USD", 1),
  crypto("ETHUSD", "Ethereum", "ETH-USD", 0.01),
  crypto("SOLUSD", "Solana", "SOL-USD", 0.01),
  crypto("AVAXUSD", "Avalanche", "AVAX-USD", 0.001),
  crypto("LINKUSD", "Chainlink", "LINK-USD", 0.001),
  crypto("DOGEUSD", "Dogecoin", "DOGE-USD", 0.00001),
];

/** Normalizes a symbol (strips contract month suffixes, uppercases). */
function normalize(symbol: string): string {
  return symbol.toUpperCase().trim();
}

export function findSymbol(symbol: string): SymbolInfo | undefined {
  const key = normalize(symbol);
  // Direct match
  const direct = SYMBOLS.find((s) => s.symbol === key);
  if (direct) return direct;
  // Match by Coinbase product ID (e.g. "BTC-USD")
  const cbKey = key.replace("-", "");
  return SYMBOLS.find((s) => s.coinbaseProductId?.replace("-", "") === cbKey);
}

export function findByCoinbaseId(productId: string): SymbolInfo | undefined {
  return SYMBOLS.find((s) => s.coinbaseProductId === productId);
}

/**
 * Whether a symbol may be traded. Futures → always true. Crypto → true
 * (exchange check done at order time by the executor). Stocks → false.
 */
export function isTradable(symbol: string): boolean {
  return findSymbol(symbol)?.tradable ?? false;
}

export function isFutures(symbol: string): boolean {
  return findSymbol(symbol)?.assetClass === "futures";
}

export function isCrypto(symbol: string): boolean {
  return findSymbol(symbol)?.assetClass === "crypto";
}

export function listByClass(assetClass: AssetClass): SymbolInfo[] {
  return SYMBOLS.filter((s) => s.assetClass === assetClass);
}

export function tradableSymbols(): SymbolInfo[] {
  return SYMBOLS.filter((s) => s.tradable);
}

export function futuresSymbols(): SymbolInfo[] {
  return SYMBOLS.filter((s) => s.assetClass === "futures");
}

export function cryptoSymbols(): SymbolInfo[] {
  return SYMBOLS.filter((s) => s.assetClass === "crypto");
}
