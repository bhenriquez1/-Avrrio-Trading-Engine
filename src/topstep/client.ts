import { randomUUID } from "node:crypto";
import type { AvrrioConfig } from "../config.js";
import type {
  AccountSummary,
  AuthTestResult,
  Bar,
  OrderRequest,
  OrderResult,
  Quote,
  TopstepConnectionState,
  TopstepStatus,
} from "../types.js";

/**
 * The auth method this build uses. TopstepX exposes the ProjectX Gateway API,
 * which authenticates with a **username + API key** via POST /api/Auth/loginKey
 * and returns a session JWT used as a Bearer token. (Password / account name are
 * NOT part of this flow — they're accepted in config for account selection and
 * future password-based login, but loginKey only needs username + API key.)
 */
const AUTH_METHOD =
  "ProjectX loginKey (username + API key -> session token)";

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
  private connectionState: TopstepConnectionState = "disconnected";
  private message = "Not connected.";

  constructor(private readonly config: AvrrioConfig) {
    this.offline = !config.topstep.apiKey || !config.topstep.username;
  }

  /** Required env vars for the loginKey flow that are currently missing. */
  missingCredentials(): string[] {
    const missing: string[] = [];
    if (!this.config.topstep.username) missing.push("TOPSTEP_USERNAME");
    if (!this.config.topstep.apiKey) missing.push("TOPSTEP_API_KEY");
    return missing;
  }

  /** Debug-safe map of which credentials are present (values masked). */
  private maskedPresence(): Record<string, string> {
    const t = this.config.topstep;
    return {
      TOPSTEP_MODE: t.mode,
      TOPSTEP_API_BASE_URL: t.baseUrl,
      TOPSTEP_USERNAME: maskValue(t.username),
      TOPSTEP_API_KEY: maskSecret(t.apiKey),
      TOPSTEP_PASSWORD: maskSecret(t.password),
      TOPSTEP_ACCOUNT_NAME: maskValue(t.accountName),
    };
  }

  /**
   * Explicit credential/auth test. Never throws and never returns a bare 401 —
   * it reports exactly which stage failed and why. Safe to call from a route.
   */
  async authTest(): Promise<AuthTestResult> {
    const present = this.maskedPresence();
    const base = { present, authMethod: AUTH_METHOD };

    if (this.offline) {
      const missing = this.missingCredentials();
      this.setState("missing_credentials", `Demo mode — missing: ${missing.join(", ")}`);
      // Log debug-safe presence (no secret values).
      console.warn("[topstepx] auth-test (demo):", present);
      return {
        ok: false,
        stage: "missing_credentials",
        missing,
        httpStatus: null,
        message: `Running in demo mode. Missing required env vars: ${missing.join(", ")}. Set them in your host environment and redeploy.`,
        ...base,
      };
    }

    console.warn("[topstepx] auth-test:", present); // masked, no secrets
    try {
      const res = await fetch(
        `${this.config.topstep.baseUrl}/api/Auth/loginKey`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userName: this.config.topstep.username,
            apiKey: this.config.topstep.apiKey,
          }),
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        this.setState(
          "invalid_credentials",
          `loginKey returned HTTP ${res.status}.`,
        );
        return {
          ok: false,
          stage: "invalid_credentials",
          missing: [],
          httpStatus: res.status,
          message: `ProjectX loginKey returned HTTP ${res.status}. Check that TOPSTEP_USERNAME and TOPSTEP_API_KEY are correct, the API key is enabled for this account, and TOPSTEP_API_BASE_URL is right. ${safeDetail(detail)}`,
          ...base,
        };
      }
      const data = (await res.json()) as {
        token?: string;
        errorMessage?: string;
        success?: boolean;
      };
      if (!data.token) {
        this.setState("token_not_returned", "No token in loginKey response.");
        return {
          ok: false,
          stage: "token_not_returned",
          missing: [],
          httpStatus: res.status,
          message: `Authenticated request succeeded but no token was returned${data.errorMessage ? `: ${data.errorMessage}` : "."}`,
          ...base,
        };
      }
      this.token = data.token;
      this.authenticated = true;
      this.setState("connected", "Authenticated with ProjectX.");
      return {
        ok: true,
        stage: "connected",
        missing: [],
        httpStatus: res.status,
        message: "Authenticated with ProjectX successfully.",
        ...base,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      this.setState("invalid_credentials", `Auth request failed: ${msg}`);
      return {
        ok: false,
        stage: "invalid_credentials",
        missing: [],
        httpStatus: null,
        message: `Could not reach ProjectX at ${this.config.topstep.baseUrl}: ${msg}`,
        ...base,
      };
    }
  }

  private setState(state: TopstepConnectionState, message: string): void {
    this.connectionState = state;
    this.message = message;
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
    if (this.offline) {
      // Demo session so the workflow is testable without real credentials.
      this.lastAccount = await this.getAccount();
      this.authenticated = true;
      this.connected = true;
      this.lastSyncTime = new Date().toISOString();
      this.setState("demo", "Connected to demo account (no credentials set).");
      return this.status();
    }

    const test = await this.authTest();
    if (!test.ok) {
      // Do NOT throw a bare 401 — surface the structured state to the dashboard.
      this.connected = false;
      this.authenticated = false;
      return this.status();
    }
    try {
      this.lastAccount = await this.getAccount();
      this.connected = true;
      this.lastSyncTime = new Date().toISOString();
      this.setState("connected", "Connected and account loaded.");
    } catch (err) {
      this.connected = false;
      this.setState(
        "invalid_credentials",
        `Authenticated but account load failed: ${err instanceof Error ? err.message : "error"}`,
      );
    }
    return this.status();
  }

  disconnect(): TopstepStatus {
    this.connected = false;
    this.authenticated = false;
    this.token = null;
    this.setState("disconnected", "Disconnected.");
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
      mode: this.config.topstep.mode,
      connectionState: this.connectionState,
      message: this.message,
      accountId: acct?.id ?? (this.offline ? "DEMO" : "unknown"),
      accountStatus: this.connected ? "active" : "inactive",
      availableBuyingPower: acct?.balance ?? 0,
      dailyPnL: acct?.dayPnl ?? 0,
      maxDailyLoss: acct?.rules.maxDailyLoss ?? 0,
      openPositions: 0,
      lastSyncTime: this.lastSyncTime,
    };
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
    if (this.token) return;
    const test = await this.authTest();
    if (!test.ok) throw new Error(test.message);
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

// --- debug-safe masking (never log raw secrets) ---------------------------

/** Masks a secret: "set (ab…yz)" showing only first/last 2 chars, or "missing". */
function maskSecret(v: string): string {
  if (!v) return "missing";
  if (v.length <= 4) return "set (****)";
  return `set (${v.slice(0, 2)}…${v.slice(-2)})`;
}

/** Masks a non-secret identifier: shows it's set without revealing the value. */
function maskValue(v: string): string {
  return v ? "set" : "missing";
}

/** Trims and truncates a server error body for safe inclusion in messages. */
function safeDetail(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t ? `Server said: ${t.slice(0, 160)}` : "";
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
