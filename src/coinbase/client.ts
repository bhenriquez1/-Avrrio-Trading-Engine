import { createSign, randomUUID } from "node:crypto";
import type { AvrrioConfig } from "../config.js";
import type { Bar, Quote } from "../types.js";

export interface CoinbaseProduct {
  productId: string;
  baseCurrencyId: string;
  quoteCurrencyId: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  status: "online" | "offline" | "internal";
}

export interface CoinbaseAccount {
  uuid: string;
  name: string;
  currency: string;
  availableBalance: number;
  hold: number;
}

export interface CoinbasePortfolio {
  /** Total portfolio value in USD */
  totalValueUsd: number;
  /** Today's realized + unrealized P&L in USD */
  dayPnlUsd: number;
  accounts: CoinbaseAccount[];
}

export interface CoinbaseOrderRequest {
  productId: string;
  side: "BUY" | "SELL";
  /** "market", "limit", "stop_limit" */
  orderType: string;
  /** Base asset quantity (e.g. BTC amount) */
  baseSize: string;
  /** For limit orders */
  limitPrice?: string;
  /** For stop orders */
  stopPrice?: string;
  clientOrderId?: string;
}

export interface CoinbaseOrderResult {
  orderId: string;
  paper: boolean;
  filled: boolean;
  filledPrice: number;
  message: string;
}

const PROD_BASE = "https://api.coinbase.com";

/**
 * Coinbase Advanced Trade client.
 *
 * Market data reads are always available (with demo fallback when offline).
 * Order writes are guarded by COINBASE_TRADING_ENABLED — the client never
 * submits a live order unless explicitly enabled.
 */
export class CoinbaseClient {
  private readonly offline: boolean;
  private readonly baseUrl: string;
  private readonly keyName: string;
  private readonly keySecret: string;

  constructor(private readonly config: AvrrioConfig) {
    this.keyName = config.coinbase.apiKeyName;
    this.keySecret = config.coinbase.apiKeySecret;
    this.offline = !this.keyName || !this.keySecret;
    this.baseUrl = config.coinbase.sandboxBaseUrl || PROD_BASE;
  }

  get isOffline(): boolean {
    return this.offline;
  }

  get tradingEnabled(): boolean {
    return this.config.coinbase.safety.tradingEnabled;
  }

  /** Test that credentials authenticate successfully. */
  async authTest(): Promise<{ ok: boolean; message: string }> {
    if (this.offline) {
      return {
        ok: false,
        message: "Coinbase credentials not configured — demo mode.",
      };
    }
    try {
      const res = await this.request("GET", "/api/v3/brokerage/accounts", null);
      if (!res.ok) {
        const body = await res.text();
        return {
          ok: false,
          message: `HTTP ${res.status}: ${body.slice(0, 200)}`,
        };
      }
      return { ok: true, message: "Coinbase authentication successful." };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getPortfolio(): Promise<CoinbasePortfolio> {
    if (this.offline) return demoPortfolio();
    try {
      const res = await this.request("GET", "/api/v3/brokerage/accounts", null);
      if (!res.ok) return demoPortfolio();
      const data = (await res.json()) as { accounts?: RawCBAccount[] };
      const accounts = (data.accounts ?? []).map(mapAccount);
      const usdAcct = accounts.find((a) => a.currency === "USD");
      const totalValueUsd =
        accounts
          .filter((a) => a.currency !== "USD")
          .reduce((sum, a) => {
            const price = DEMO_PRICES[`${a.currency}-USD`] ?? 0;
            return sum + a.availableBalance * price;
          }, 0) + (usdAcct?.availableBalance ?? 0);
      return { totalValueUsd, dayPnlUsd: 0, accounts };
    } catch {
      return demoPortfolio();
    }
  }

  async getQuote(productId: string): Promise<Quote> {
    if (this.offline) return demoCryptoQuote(productId);
    try {
      const res = await this.request(
        "GET",
        `/api/v3/brokerage/products/${encodeURIComponent(productId)}/ticker`,
        null,
      );
      if (!res.ok) return demoCryptoQuote(productId);
      const raw = (await res.json()) as RawCBTicker;
      const last = Number(raw.price ?? raw.trades?.[0]?.price ?? 0);
      return {
        symbol: productId,
        bid: last * 0.9995,
        ask: last * 1.0005,
        last,
        timestamp: new Date().toISOString(),
      };
    } catch {
      return demoCryptoQuote(productId);
    }
  }

  async getBars(productId: string, limit = 50): Promise<Bar[]> {
    if (this.offline) return demoCryptoBars(productId, limit);
    try {
      const end = Math.floor(Date.now() / 1000);
      const start = end - limit * 300; // 5-min bars
      const res = await this.request(
        "GET",
        `/api/v3/brokerage/products/${encodeURIComponent(productId)}/candles?start=${start}&end=${end}&granularity=FIVE_MINUTE`,
        null,
      );
      if (!res.ok) return demoCryptoBars(productId, limit);
      const data = (await res.json()) as { candles?: RawCBCandle[] };
      return (data.candles ?? []).slice(0, limit).map((c) => ({
        symbol: productId,
        timestamp: new Date(Number(c.start) * 1000).toISOString(),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
      }));
    } catch {
      return demoCryptoBars(productId, limit);
    }
  }

  async listProducts(): Promise<CoinbaseProduct[]> {
    if (this.offline) return demoProducts();
    try {
      const res = await this.request(
        "GET",
        "/api/v3/brokerage/products?product_type=SPOT",
        null,
      );
      if (!res.ok) return demoProducts();
      const data = (await res.json()) as { products?: RawCBProduct[] };
      return (data.products ?? [])
        .filter((p) => CRYPTO_PRODUCT_IDS.includes(p.product_id))
        .map(mapProduct);
    } catch {
      return demoProducts();
    }
  }

  /** Paper-only order submission. Real orders require tradingEnabled + live keys. */
  async submitOrder(req: CoinbaseOrderRequest): Promise<CoinbaseOrderResult> {
    const clientOrderId = req.clientOrderId ?? randomUUID();

    if (!this.tradingEnabled) {
      return {
        orderId: `PAPER-${clientOrderId}`,
        paper: true,
        filled: true,
        filledPrice: DEMO_PRICES[req.productId] ?? 0,
        message: `Paper fill simulated (COINBASE_TRADING_ENABLED=false). ${req.side} ${req.baseSize} ${req.productId}`,
      };
    }

    if (this.offline) {
      return {
        orderId: `PAPER-OFFLINE-${clientOrderId}`,
        paper: true,
        filled: true,
        filledPrice: DEMO_PRICES[req.productId] ?? 0,
        message: "Offline demo fill — no credentials configured.",
      };
    }

    const body = {
      client_order_id: clientOrderId,
      product_id: req.productId,
      side: req.side,
      order_configuration: buildOrderConfig(req),
    };

    const res = await this.request("POST", "/api/v3/brokerage/orders", body);
    const data = (await res.json()) as {
      success?: boolean;
      order_id?: string;
      error_response?: { message?: string };
    };

    if (!data.success) {
      throw new Error(
        data.error_response?.message ??
          `Coinbase order rejected (HTTP ${res.status})`,
      );
    }

    return {
      orderId: data.order_id ?? clientOrderId,
      paper: false,
      filled: false,
      filledPrice: 0,
      message: `Live order submitted: ${req.side} ${req.baseSize} ${req.productId}`,
    };
  }

  private buildJwt(method: string, path: string): string {
    const now = Math.floor(Date.now() / 1000);
    const uri = `${method} api.coinbase.com${path}`;
    const header = Buffer.from(
      JSON.stringify({
        alg: "ES256",
        kid: this.keyName,
        nonce: randomUUID().replace(/-/g, ""),
      }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: this.keyName,
        iss: "cdp",
        nbf: now,
        exp: now + 120,
        uri,
      }),
    ).toString("base64url");
    const sigInput = `${header}.${payload}`;
    const sign = createSign("SHA256");
    sign.update(sigInput);
    const sig = sign
      .sign({ key: this.keySecret, dsaEncoding: "ieee-p1363" })
      .toString("base64url");
    return `${sigInput}.${sig}`;
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
  ): Promise<Response> {
    const jwt = this.buildJwt(method, path);
    const url = `${this.baseUrl}${path}`;
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: body !== null ? JSON.stringify(body) : undefined,
    });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function buildOrderConfig(req: CoinbaseOrderRequest) {
  if (req.orderType === "limit") {
    return {
      limit_limit_gtc: {
        base_size: req.baseSize,
        limit_price: req.limitPrice ?? "0",
        post_only: false,
      },
    };
  }
  if (req.orderType === "stop_limit") {
    return {
      stop_limit_stop_limit_gtc: {
        base_size: req.baseSize,
        limit_price: req.limitPrice ?? "0",
        stop_price: req.stopPrice ?? "0",
      },
    };
  }
  // market
  return { market_market_ioc: { base_size: req.baseSize } };
}

// ─── raw API shapes ────────────────────────────────────────────────────────────

interface RawCBAccount {
  uuid: string;
  name: string;
  currency: string;
  available_balance: { value: string };
  hold: { value: string };
}

interface RawCBTicker {
  price?: string;
  trades?: { price: string }[];
}

interface RawCBCandle {
  start: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

interface RawCBProduct {
  product_id: string;
  base_currency_id: string;
  quote_currency_id: string;
  price: string;
  price_percentage_change_24h: string;
  volume_24h: string;
  status: string;
}

function mapAccount(raw: RawCBAccount): CoinbaseAccount {
  return {
    uuid: raw.uuid,
    name: raw.name,
    currency: raw.currency,
    availableBalance: Number(raw.available_balance?.value ?? 0),
    hold: Number(raw.hold?.value ?? 0),
  };
}

function mapProduct(raw: RawCBProduct): CoinbaseProduct {
  return {
    productId: raw.product_id,
    baseCurrencyId: raw.base_currency_id,
    quoteCurrencyId: raw.quote_currency_id,
    price: Number(raw.price ?? 0),
    priceChange24h: Number(raw.price_percentage_change_24h ?? 0),
    volume24h: Number(raw.volume_24h ?? 0),
    status: (raw.status as CoinbaseProduct["status"]) ?? "online",
  };
}

// ─── demo data ────────────────────────────────────────────────────────────────

export const CRYPTO_PRODUCT_IDS = [
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "AVAX-USD",
  "LINK-USD",
  "DOGE-USD",
];

export const DEMO_PRICES: Record<string, number> = {
  "BTC-USD": 107250,
  "ETH-USD": 3840,
  "SOL-USD": 178,
  "AVAX-USD": 38,
  "LINK-USD": 19.5,
  "DOGE-USD": 0.185,
};

const DEMO_24H_CHANGE: Record<string, number> = {
  "BTC-USD": 2.4,
  "ETH-USD": 1.8,
  "SOL-USD": -0.9,
  "AVAX-USD": 3.1,
  "LINK-USD": -1.4,
  "DOGE-USD": 0.6,
};

function demoCryptoQuote(productId: string): Quote {
  const price = DEMO_PRICES[productId] ?? 1;
  const spread = price * 0.0005;
  return {
    symbol: productId,
    bid: price - spread,
    ask: price + spread,
    last: price,
    timestamp: new Date().toISOString(),
  };
}

function demoCryptoBars(productId: string, limit: number): Bar[] {
  const base = DEMO_PRICES[productId] ?? 1;
  const bars: Bar[] = [];
  const now = Date.now();
  for (let i = limit; i >= 0; i--) {
    const drift = ((Math.random() - 0.49) * 0.008 * base * i) / limit;
    const open = base + drift;
    const range = open * 0.003;
    bars.push({
      symbol: productId,
      timestamp: new Date(now - i * 300_000).toISOString(),
      open,
      high: open + range,
      low: open - range,
      close: open + (Math.random() - 0.5) * range,
      volume: Math.random() * 500 + 100,
    });
  }
  return bars;
}

function demoPortfolio(): CoinbasePortfolio {
  return {
    totalValueUsd: 5000,
    dayPnlUsd: 47.5,
    accounts: [
      {
        uuid: "demo-usd",
        name: "USD Wallet",
        currency: "USD",
        availableBalance: 2500,
        hold: 0,
      },
      {
        uuid: "demo-btc",
        name: "BTC Wallet",
        currency: "BTC",
        availableBalance: 0.023,
        hold: 0,
      },
      {
        uuid: "demo-eth",
        name: "ETH Wallet",
        currency: "ETH",
        availableBalance: 0.65,
        hold: 0,
      },
    ],
  };
}

function demoProducts(): CoinbaseProduct[] {
  return CRYPTO_PRODUCT_IDS.map((id) => ({
    productId: id,
    baseCurrencyId: id.split("-")[0] ?? id,
    quoteCurrencyId: "USD",
    price: DEMO_PRICES[id] ?? 1,
    priceChange24h: DEMO_24H_CHANGE[id] ?? 0,
    volume24h: Math.random() * 1e8 + 1e7,
    status: "online" as const,
  }));
}
