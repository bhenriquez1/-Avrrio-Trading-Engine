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
  private usingFallbackData = false;
  private fallbackWarned = false;

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
      TOPSTEP_ACCOUNT_ID: maskValue(t.accountId),
    };
  }

  /**
   * Explicit credential/auth test. Never throws and never returns a bare 401 —
   * it reports exactly which stage failed and why. Safe to call from a route.
   */
  async authTest(): Promise<AuthTestResult> {
    const present = this.maskedPresence();
    const endpoint = `${this.config.topstep.baseUrl}/api/Auth/loginKey`;
    const extras = { tokenReceived: false, accountFound: false, accountId: "", accountName: "", lastError: "" };
    const base = { present, authMethod: AUTH_METHOD, endpoint };

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
        ...extras,
        lastError: `Missing: ${missing.join(", ")}`,
        ...base,
      };
    }

    console.warn(`[topstepx] auth-test POST ${endpoint}`, present); // masked, no secrets
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userName: this.config.topstep.username,
          apiKey: this.config.topstep.apiKey,
        }),
      });
      const raw = await res.text().catch(() => "");
      // Sanitize: ProjectX echoes no secrets, but truncate + strip any token-like
      // values defensively before logging.
      const sanitized = sanitizeBody(raw);
      console.warn(
        `[topstepx] auth-test response: HTTP ${res.status} ${endpoint} body=${sanitized}`,
      );

      if (!res.ok) {
        this.setState(
          "invalid_credentials",
          `loginKey returned HTTP ${res.status}.`,
        );
        return {
          ok: false,
          stage: "invalid_credentials",
          missing: [],
          httpStatus: res.status,
          message: `ProjectX loginKey returned HTTP ${res.status}. Check TOPSTEP_USERNAME, TOPSTEP_API_KEY, and TOPSTEP_API_BASE_URL. ${sanitized ? "Server said: " + sanitized : ""}`,
          ...extras,
          lastError: sanitized || `HTTP ${res.status}`,
          ...base,
        };
      }

      const data = parseJson(raw);
      const token = data.token ?? data.Token ?? data.accessToken;
      if (!token) {
        const why = data.errorMessage ?? data.message ?? "";
        // ProjectX can return HTTP 200 with success=false and token=null — that
        // is a rejected-credentials response, not an ambiguous missing-field
        // case, so classify it as invalid_credentials with actionable guidance.
        if (data.success === false) {
          const msg =
            `ProjectX rejected the live login (HTTP ${res.status}, success=false, token=null)` +
            (why ? `: "${why}". ` : ". ") +
            "Verify TOPSTEP_USERNAME, TOPSTEP_API_KEY, TOPSTEP_ACCOUNT_ID, and TOPSTEP_ACCOUNT_NAME match your LIVE TopstepX/ProjectX account exactly, TOPSTEP_API_BASE_URL is correct, and the API key is enabled for live use (set TOPSTEP_PASSWORD too if your account requires password-based confirmation). " +
            `Response: ${sanitized || "(empty)"}`;
          this.setState("invalid_credentials", msg);
          return {
            ok: false,
            stage: "invalid_credentials",
            missing: [],
            httpStatus: res.status,
            message: msg,
            ...extras,
            lastError: sanitized || "ProjectX returned success=false with token=null",
            ...base,
          };
        }
        this.setState(
          "token_not_returned",
          `No token in loginKey response${why ? ` (${why})` : ""}.`,
        );
        return {
          ok: false,
          stage: "token_not_returned",
          missing: [],
          httpStatus: res.status,
          message:
            `Authenticated request succeeded (HTTP ${res.status}) but no token was returned. ` +
            (why
              ? `ProjectX said: "${why}". This usually means the API key is invalid/disabled or the wrong field was supplied. `
              : "") +
            `Response: ${sanitized || "(empty)"}`,
          ...extras,
          lastError: sanitized || "Token missing from response",
          ...base,
        };
      }

      this.token = String(token);
      this.authenticated = true;

      let account: AccountSummary | null = null;
      let accountError = "";
      try {
        account = await this.getAccount();
        this.lastAccount = account;
      } catch (err) {
        accountError = err instanceof Error ? err.message : "Account lookup failed";
      }

      if (!account) {
        this.setState("connected", `ProjectX auth passed, but no account was found: ${accountError}`);
        return {
          ok: false,
          stage: "connected",
          missing: [],
          httpStatus: res.status,
          message: `ProjectX auth passed and token was received, but no TopstepX account was found. Verify TOPSTEP_ACCOUNT_ID and TOPSTEP_ACCOUNT_NAME. ${accountError}`,
          tokenReceived: true,
          accountFound: false,
          accountId: "",
          accountName: "",
          lastError: accountError,
          ...base,
        };
      }

      this.setState("connected", "Authenticated with ProjectX and account found.");
      return {
        ok: true,
        stage: "connected",
        missing: [],
        httpStatus: res.status,
        message: "Authenticated with ProjectX successfully and TopstepX account found.",
        tokenReceived: true,
        accountFound: true,
        accountId: account.id,
        accountName: account.name,
        lastError: "",
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
        message: `Could not reach ProjectX at ${endpoint}: ${msg}`,
        ...extras,
        lastError: msg,
        ...base,
      };
    }
  }

  private setState(state: TopstepConnectionState, message: string): void {
    this.connectionState = state;
    this.message = message;
  }

  /** Records that a market read fell back to demo data (logs once per session). */
  private noteFallback(err: unknown): void {
    this.usingFallbackData = true;
    if (!this.fallbackWarned) {
      this.fallbackWarned = true;
      console.warn(
        `[topstepx] market read failed; using simulated data for scans: ${err instanceof Error ? err.message : "error"}`,
      );
    }
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
      usingFallbackData: this.usingFallbackData,
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
    const accounts = data.accounts ?? [];
    const raw = selectAccount(accounts, this.config.topstep.accountId, this.config.topstep.accountName);
    if (!raw) throw new Error(accountNotFoundMessage(accounts.length, this.config.topstep.accountId, this.config.topstep.accountName));
    return mapAccount(raw);
  }

  async getQuote(symbol: string): Promise<Quote> {
    if (this.offline) return demoQuote(symbol);
    try {
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
    } catch (err) {
      // Don't let a broken auth crash the scanner — fall back to demo data and
      // flag it so the dashboard can warn that market data is simulated.
      this.noteFallback(err);
      return demoQuote(symbol);
    }
  }

  async getBars(symbol: string, limit = 50): Promise<Bar[]> {
    if (this.offline) return demoBars(symbol, limit);
    try {
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
    } catch (err) {
      this.noteFallback(err);
      return demoBars(symbol, limit);
    }
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

/**
 * Sanitizes a response body for safe logging/display: collapses whitespace,
 * truncates, and redacts any long token-like values defensively.
 */
function sanitizeBody(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/("?(?:token|accessToken|apiKey)"?\s*[:=]\s*"?)[A-Za-z0-9._-]{8,}/gi, "$1<redacted>")
    .trim()
    .slice(0, 200);
}

/** Parses JSON defensively; returns {} on failure. */
function parseJson(s: string): {
  token?: string;
  Token?: string;
  accessToken?: string;
  errorMessage?: string;
  message?: string;
  success?: boolean;
} {
  try {
    return JSON.parse(s) as Record<string, never>;
  } catch {
    return {};
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

function selectAccount(accounts: RawAccount[], accountId: string, accountName: string): RawAccount | undefined {
  if (accountId) {
    const byId = accounts.find((a) => String(a.id) === accountId);
    if (byId) return byId;
  }
  if (accountName) {
    const wanted = accountName.trim().toLowerCase();
    const byName = accounts.find((a) => (a.name ?? "").trim().toLowerCase() === wanted);
    if (byName) return byName;
  }
  return accounts[0];
}

function accountNotFoundMessage(count: number, accountId: string, accountName: string): string {
  if (count === 0) return "No active TopstepX account found.";
  const filters = [accountId ? `TOPSTEP_ACCOUNT_ID=${accountId}` : "", accountName ? "TOPSTEP_ACCOUNT_NAME is set" : ""].filter(Boolean).join(" and ");
  return filters ? `Found ${count} account(s), but none matched ${filters}.` : `Found ${count} account(s), but could not select an account.`;
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
