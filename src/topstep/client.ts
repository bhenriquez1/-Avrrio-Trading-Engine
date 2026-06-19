import { randomUUID } from "node:crypto";
import type { AvrrioConfig } from "../config.js";
import type {
  AccountSummary,
  Bar,
  OrderRequest,
  OrderResult,
  Quote,
  TopstepStatus,
} from "../types.js";

/**
 * TopstepX / ProjectX API client.
 *
 * Reads are always available. The single write method, `submitOrder`, is
 * low-level and UNGUARDED — it must ONLY be called by the OrderExecutor, which
 * enforces the kill switch, approval, live-trading flag, and all safety gates
 * first. Never call `submitOrder` directly from a route or the CLI.
 *
 * When credentials are missing, every method falls back to deterministic demo
 * data / simulated fills so the whole engine can run offline.
 */
export class TopstepClient {
  private token: string | null = null;
  private readonly offline: boolean;

  // Connection state (drives execution gating + the dashboard card).
  private connected = false;
  private authenticated = false;
  private lastSyncTime: string | null = null;
  private lastAccount: AccountSummary | null = null;

  constructor(private readonly config: AvrrioConfig) {
    this.offline = !config.topstep.apiKey || !config.topstep.username;
  }

  get isOffline(): boolean {
    return this.offline;
  }

  /** True when a usable session is established (real auth, or demo session). */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Establish a session. In live mode this authenticates and loads the account;
   * in offline/demo mode it establishes a paper session so the workflow can be
   * exercised end to end.
   */
  async connect(): Promise<TopstepStatus> {
    if (!this.offline) {
      await this.authenticate();
      this.lastAccount = await this.getAccount();
      this.authenticated = true;
    } else {
      this.lastAccount = await this.getAccount(); // demo account
      this.authenticated = true;
    }
    this.connected = true;
    this.lastSyncTime = new Date().toISOString();
    return this.status();
  }

  disconnect(): TopstepStatus {
    this.connected = false;
    this.authenticated = false;
    this.token = null;
    return this.status();
  }

  /** Refresh the cached account snapshot from the broker. */
  async sync(): Promise<TopstepStatus> {
    if (!this.connected) return this.status();
    this.lastAccount = await this.getAccount();
    this.lastSyncTime = new Date().toISOString();
    return this.status();
  }

  status(): TopstepStatus {
    const acct = this.lastAccount;
    return {
      connected: this.connected,
      authenticated: this.authenticated,
      offline: this.offline,
      accountId: acct?.id ?? (this.offline ? "DEMO" : "unknown"),
      accountStatus: this.connected ? "active" : "inactive",
      availableBuyingPower: acct?.balance ?? 0,
      dailyPnL: acct?.dayPnl ?? 0,
      maxDailyLoss: acct?.rules.maxDailyLoss ?? 0,
      openPositions: 0,
      lastSyncTime: this.lastSyncTime,
    };
  }

  /**
   * Authenticate against ProjectX and cache a session token.
   * ProjectX uses a login-with-key flow; adjust the path/payload to match the
   * exact gateway your account points at (see docs/setup.md).
   */
  async authenticate(): Promise<void> {
    if (this.offline) return;
    const res = await this.request("/api/Auth/loginKey", {
      method: "POST",
      body: JSON.stringify({
        userName: this.config.topstep.username,
        apiKey: this.config.topstep.apiKey,
      }),
    });
    const data = (await res.json()) as { token?: string };
    if (!data.token) {
      throw new Error("ProjectX authentication did not return a token.");
    }
    this.token = data.token;
  }

  async getAccount(): Promise<AccountSummary> {
    if (this.offline) return demoAccount();
    await this.ensureAuth();
    const res = await this.request("/api/Account/search", {
      method: "POST",
      body: JSON.stringify({ onlyActiveAccounts: true }),
    });
    const data = (await res.json()) as { accounts?: RawAccount[] };
    const raw = data.accounts?.[0];
    if (!raw) throw new Error("No active TopstepX account found.");
    return mapAccount(raw);
  }

  async getQuote(symbol: string): Promise<Quote> {
    if (this.offline) return demoQuote(symbol);
    await this.ensureAuth();
    const res = await this.request(
      `/api/Market/quote?symbol=${encodeURIComponent(symbol)}`,
      { method: "GET" },
    );
    const raw = (await res.json()) as RawQuote;
    return {
      symbol,
      bid: raw.bid,
      ask: raw.ask,
      last: raw.last,
      timestamp: raw.timestamp ?? new Date().toISOString(),
    };
  }

  async getBars(symbol: string, limit = 50): Promise<Bar[]> {
    if (this.offline) return demoBars(symbol, limit);
    await this.ensureAuth();
    const res = await this.request("/api/Market/bars", {
      method: "POST",
      body: JSON.stringify({ symbol, limit }),
    });
    const data = (await res.json()) as { bars?: RawBar[] };
    return (data.bars ?? []).map((b) => ({
      symbol,
      timestamp: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v,
    }));
  }

  /**
   * Low-level order submission. UNGUARDED — see the class doc. The executor is
   * responsible for every safety check before this is reached. In offline mode,
   * or when the caller has not enabled live trading, it returns a simulated fill.
   */
  async submitOrder(order: OrderRequest, live: boolean): Promise<OrderResult> {
    if (this.offline || !live) {
      return {
        accepted: true,
        orderId: `PAPER-${randomUUID().slice(0, 8)}`,
        paper: true,
        message: this.offline
          ? "Simulated fill (offline mode)."
          : "Simulated fill (live trading disabled).",
      };
    }
    await this.ensureAuth();
    const res = await this.request("/api/Order/place", {
      method: "POST",
      body: JSON.stringify({
        symbol: order.symbol,
        side: order.side === "long" ? "Buy" : "Sell",
        size: order.size,
        type: "Limit",
        limitPrice: order.entry,
        stopLoss: order.stopLoss,
        takeProfit: order.target,
      }),
    });
    const data = (await res.json()) as { orderId?: string | number };
    return {
      accepted: true,
      orderId: String(data.orderId ?? "unknown"),
      paper: false,
      message: "Order submitted to TopstepX.",
    };
  }

  // --- internals ---------------------------------------------------------

  private async ensureAuth(): Promise<void> {
    if (!this.token) await this.authenticate();
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.config.topstep.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `TopstepX request failed ${res.status} ${path}: ${text.slice(0, 200)}`,
      );
    }
    return res;
  }
}

// --- raw wire shapes (best-effort; confirm against ProjectX docs) ---------

interface RawAccount {
  id: number | string;
  name?: string;
  balance?: number;
  dayProfitLoss?: number;
  maxDailyLoss?: number;
  maxDrawdown?: number;
  maxPositionSize?: number;
}

interface RawQuote {
  bid: number;
  ask: number;
  last: number;
  timestamp?: string;
}

interface RawBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function mapAccount(raw: RawAccount): AccountSummary {
  return {
    id: String(raw.id),
    name: raw.name ?? "TopstepX Account",
    balance: raw.balance ?? 0,
    dayPnl: raw.dayProfitLoss ?? 0,
    rules: {
      maxDailyLoss: raw.maxDailyLoss ?? 0,
      maxDrawdown: raw.maxDrawdown ?? 0,
      maxPositionSize: raw.maxPositionSize ?? 0,
    },
  };
}

// --- deterministic demo data (offline mode) -------------------------------

function demoAccount(): AccountSummary {
  return {
    id: "DEMO-50K",
    name: "Avrrio Demo (50K Combine)",
    balance: 50_000,
    dayPnl: -350,
    rules: { maxDailyLoss: 1_000, maxDrawdown: 2_000, maxPositionSize: 5 },
  };
}

function demoQuote(symbol: string): Quote {
  const base = symbol.toUpperCase().includes("NQ") ? 20_000 : 5_300;
  return {
    symbol,
    bid: base - 0.25,
    ask: base + 0.25,
    last: base,
    timestamp: new Date().toISOString(),
  };
}

function demoBars(symbol: string, limit: number): Bar[] {
  const base = symbol.toUpperCase().includes("NQ") ? 20_000 : 5_300;
  const out: Bar[] = [];
  for (let i = 0; i < limit; i++) {
    const drift = Math.sin(i / 4) * (base * 0.001);
    const close = base + drift;
    out.push({
      symbol,
      timestamp: new Date(Date.now() - (limit - i) * 60_000).toISOString(),
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 1_000 + i * 10,
    });
  }
  return out;
}
