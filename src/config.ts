import "dotenv/config";
import { parseTradingMode, type TradingMode } from "./types.js";

/**
 * Central configuration, loaded once from the environment.
 *
 * Safety-critical flags default to the SAFE value. Real trading requires the
 * operator to explicitly opt in via environment variables.
 */
export interface AvrrioConfig {
  topstep: {
    /** "practice" (paper account) or "live". Default practice. */
    mode: "practice" | "live";
    baseUrl: string;
    username: string;
    password: string;
    apiKey: string;
    accountName: string;
    accountId: string;
  };
  ai: {
    anthropicApiKey: string;
    claudeModel: string;
    openaiApiKey: string;
    openaiModel: string;
    /** Optional third opinion ("TradeGPT" or any OpenAI-compatible endpoint). */
    tradegptApiKey: string;
    tradegptBaseUrl: string;
    tradegptModel: string;
    /** Minimum confidence (0..1) for a semi-autonomous auto-execution. */
    confidenceThreshold: number;
  };
  execution: {
    /** Master switch for sending real orders. Default false. */
    liveTradingEnabled: boolean;
    /** Allows auto-execution when ALL gates pass. Default false. */
    semiAutonomousEnabled: boolean;
    /**
     * How the engine acts on a setup: advisor (alert only, no orders),
     * telegram_approval (one-tap approve to execute), or full_auto. Default
     * telegram_approval — the safe assistant middle ground.
     */
    tradingMode: TradingMode;
  };
  safety: {
    /** Hard stop — when true, every trade is blocked. */
    killSwitch: boolean;
    /** Daily realized+unrealized loss cap (USD) before new trades are blocked. */
    dailyMaxLoss: number;
    /** Largest position (contracts) any single order may request. */
    maxPositionSize: number;
    /** Maximum number of trades allowed per calendar day. */
    maxTradesPerDay: number;
    /** Hard cap on dollar risk for a single trade. 0 = use policy only. */
    maxRiskPerTrade: number;
  };
  dashboard: {
    port: number;
    /** Password required to log in to the dashboard / approve trades. */
    password: string;
  };
  scheduler: {
    /** Master switch for the 20-min scheduled scanner. Default false. */
    enabled: boolean;
    /** Scan cadence in minutes. */
    intervalMinutes: number;
    /** Minimum reward/risk to qualify for an alert. */
    minRewardRisk: number;
    /** Max number of alerts per cycle (keep it useful, not noise). */
    maxAlerts: number;
    /** Local hour (0-23) to send the daily summary; -1 disables. */
    dailySummaryHour: number;
    /** Local hours (0-23) to send scheduled day reports (morning/midday/close). */
    reportHours: number[];
  };
  /** Public base URL used to build approve/reject links in notifications. */
  publicBaseUrl: string;
  /** IANA timezone for report titles/labels (e.g. "America/New_York"). Empty = server local. */
  accountTimezone: string;
  queue: {
    /** Minutes a recommendation stays valid for approval before it expires. */
    approvalExpiryMinutes: number;
    /** How close (fraction of price) the last price must get to entry to trigger. */
    entryTriggerTolerancePct: number;
  };
  notifications: {
    enabled: boolean;
    /** Avrrio Score at/above which a scanner opportunity triggers an alert. */
    opportunityAlertScore: number;
    email: {
      enabled: boolean;
      to: string;
      from: string;
      sendgridApiKey: string;
    };
    telegram: {
      enabled: boolean;
      botToken: string;
      chatId: string;
    };
    sms: {
      enabled: boolean;
      /** Provider id (currently only "twilio"). */
      provider: string;
      twilioAccountSid: string;
      twilioAuthToken: string;
      fromNumber: string;
      /** Authorized phone number for alerts and inbound approval replies. */
      toNumber: string;
    };
  };
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

/** Parses a comma-separated list of hours (0-23) into a sorted unique array. */
function parseHours(raw: string): number[] {
  const hours = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
  return [...new Set(hours)].sort((a, b) => a - b);
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Case-insensitive lookup across `process.env` over a list of candidate names.
 * Tolerates the mixed-case / variant keys that creep into hosting dashboards
 * (e.g. `TOPSTEP_Practice_Username`). Returns the first non-empty match.
 */
function envAny(names: string[], fallback = ""): string {
  const lower: Record<string, string> = {};
  for (const [k, val] of Object.entries(process.env)) {
    if (val !== undefined) lower[k.toLowerCase()] = val;
  }
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v !== undefined && v !== "") return v;
  }
  return fallback;
}

export function loadConfig(): AvrrioConfig {
  const mode =
    env("TOPSTEP_MODE", "live").toLowerCase() === "practice"
      ? "practice"
      : "live";
  return {
    topstep: {
      mode,
      baseUrl: env("TOPSTEP_API_BASE_URL", "https://api.topstepx.com"),
      username: env("TOPSTEP_USERNAME"),
      password: env("TOPSTEP_PASSWORD"),
      apiKey: env("TOPSTEP_API_KEY"),
      accountName: env("TOPSTEP_ACCOUNT_NAME"),
      accountId: env("TOPSTEP_ACCOUNT_ID"),
    },
    ai: {
      anthropicApiKey: env("ANTHROPIC_API_KEY"),
      claudeModel: env("AVRRIO_CLAUDE_MODEL", "claude-opus-4-8"),
      openaiApiKey: env("OPENAI_API_KEY"),
      openaiModel: env("AVRRIO_OPENAI_MODEL", "gpt-4o"),
      tradegptApiKey: env("TRADEGPT_API_KEY"),
      tradegptBaseUrl: env("TRADEGPT_BASE_URL"),
      tradegptModel: env("TRADEGPT_MODEL", "gpt-4o-mini"),
      confidenceThreshold: num("AVRRIO_CONFIDENCE_THRESHOLD", 0.9),
    },
    execution: {
      liveTradingEnabled: bool("LIVE_TRADING_ENABLED", false),
      semiAutonomousEnabled: bool("SEMI_AUTONOMOUS_ENABLED", false),
      // TRADING_MODE wins; for back-compat, SEMI_AUTONOMOUS_ENABLED=true implies
      // full_auto only when TRADING_MODE is not explicitly set.
      tradingMode: parseTradingMode(
        process.env.TRADING_MODE ??
          (bool("SEMI_AUTONOMOUS_ENABLED", false)
            ? "full_auto"
            : "telegram_approval"),
      ),
    },
    safety: {
      killSwitch: bool("KILL_SWITCH", false),
      dailyMaxLoss: num("DAILY_MAX_LOSS", 0),
      maxPositionSize: num("MAX_POSITION_SIZE", 0),
      maxTradesPerDay: num("MAX_TRADES_PER_DAY", 2),
      maxRiskPerTrade: num("MAX_RISK_PER_TRADE", 0),
    },
    dashboard: {
      // Render (and most PaaS) inject PORT; fall back to DASHBOARD_PORT locally.
      port: num("PORT", num("DASHBOARD_PORT", 4317)),
      password: env("DASHBOARD_PASSWORD"),
    },
    scheduler: {
      enabled: bool("SCHEDULED_SCANNER_ENABLED", false),
      intervalMinutes: num("SCAN_INTERVAL_MINUTES", 20),
      minRewardRisk: num("AVRRIO_MIN_RR", 2),
      maxAlerts: num("AVRRIO_MAX_ALERTS", 3),
      dailySummaryHour: num("DAILY_SUMMARY_HOUR", -1),
      reportHours: parseHours(env("REPORT_HOURS", "8,12,16")),
    },
    publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:4317"),
    accountTimezone: env("ACCOUNT_TIMEZONE").trim(),
    queue: {
      approvalExpiryMinutes: num("NOTIFICATION_EXPIRY_MINUTES", 5),
      entryTriggerTolerancePct: num("EXEC_TRIGGER_TOLERANCE_PCT", 0.001),
    },
    notifications: {
      enabled: bool("PHONE_NOTIFICATIONS_ENABLED", false),
      opportunityAlertScore: num("AVRRIO_ALERT_SCORE", 85),
      email: {
        enabled: bool("EMAIL_NOTIFICATIONS_ENABLED", true),
        to: env("NOTIFICATION_EMAIL_TO"),
        from: env("NOTIFICATION_EMAIL_FROM", "alerts@avrrio.local"),
        sendgridApiKey: env("SENDGRID_API_KEY"),
      },
      telegram: {
        enabled: bool("TELEGRAM_ENABLED", false),
        // Trim to tolerate stray whitespace/newlines pasted into host env vars.
        botToken: env("TELEGRAM_BOT_TOKEN").trim(),
        chatId: env("TELEGRAM_CHAT_ID").trim(),
      },
      sms: {
        enabled: bool("SMS_ENABLED", false),
        provider: env("SMS_PROVIDER", "twilio"),
        twilioAccountSid: env("TWILIO_ACCOUNT_SID"),
        twilioAuthToken: env("TWILIO_AUTH_TOKEN"),
        fromNumber: env("TWILIO_FROM_NUMBER"),
        // ALERT_PHONE_NUMBER is the canonical name; BRIAN_PHONE_NUMBER kept for compat.
        toNumber: env("ALERT_PHONE_NUMBER", env("BRIAN_PHONE_NUMBER")),
      },
    },
  };
}

/**
 * Human-readable warnings about missing/unsafe configuration.
 * Surfaced in the dashboard and CLI so the operator always knows the engine's
 * safety posture.
 */
/**
 * Warns when deprecated/variant env names are present, nudging the operator to
 * the canonical names. Legacy names still work (via envAny) but are discouraged.
 */
export function legacyEnvWarnings(): string[] {
  const present = new Set(Object.keys(process.env).map((k) => k.toLowerCase()));
  const legacy: Array<[string, string]> = [
    ["TOPSTEP_PRACTICE_USERNAME", "TOPSTEP_USERNAME"],
    ["TOPSTEP_USER", "TOPSTEP_USERNAME"],
    ["TOPSTEP_PRACTICE_PASSWORD", "TOPSTEP_PASSWORD"],
    ["TOPSTEP_APIKEY", "TOPSTEP_API_KEY"],
    ["PROJECTX_API_KEY", "TOPSTEP_API_KEY"],
    ["TOPSTEP_BASE_URL", "TOPSTEP_API_BASE_URL"],
    ["TOPSTEP_ACCOUNTNAME", "TOPSTEP_ACCOUNT_NAME"],
    ["BRIAN_PHONE_NUMBER", "ALERT_PHONE_NUMBER"],
  ];
  const warnings: string[] = [];
  for (const [old, canonical] of legacy) {
    if (present.has(old.toLowerCase())) {
      warnings.push(
        `Legacy env var "${old}" is set — rename it to "${canonical}". The old name is ignored by this build.`,
      );
    }
  }
  return warnings;
}

/**
 * Optional runtime overrides so warnings reflect dashboard-toggled state
 * (persisted in RuntimeSettings), not just the env defaults baked into config.
 */
export interface WarningOverrides {
  liveTradingEnabled?: boolean;
  tradingMode?: TradingMode;
}

export function configWarnings(
  config: AvrrioConfig,
  overrides: WarningOverrides = {},
): string[] {
  const liveTradingEnabled =
    overrides.liveTradingEnabled ?? config.execution.liveTradingEnabled;
  const tradingMode = overrides.tradingMode ?? config.execution.tradingMode;
  const warnings: string[] = [];
  if (!config.topstep.apiKey || !config.topstep.username) {
    const missing: string[] = [];
    if (!config.topstep.username) missing.push("TOPSTEP_USERNAME");
    if (!config.topstep.apiKey) missing.push("TOPSTEP_API_KEY");
    warnings.push(
      `TopstepX not connectable — missing ${missing.join(", ")} (mode=${config.topstep.mode}). Running in OFFLINE/demo mode. Use POST /api/topstepx/auth-test for details.`,
    );
  }
  warnings.push(...legacyEnvWarnings());
  if (!config.ai.anthropicApiKey) {
    warnings.push(
      "ANTHROPIC_API_KEY is not set — Claude analysis is disabled.",
    );
  }
  if (!config.dashboard.password) {
    warnings.push(
      "DASHBOARD_PASSWORD is not set — the dashboard is UNPROTECTED. Set a password before exposing it.",
    );
  }
  if (liveTradingEnabled) {
    warnings.push(
      "LIVE_TRADING_ENABLED is true — approved trades will be sent to TopstepX for real.",
    );
  } else {
    warnings.push(
      "LIVE_TRADING_ENABLED is false — approvals are simulated (paper). No real orders are sent.",
    );
  }
  if (tradingMode === "full_auto") {
    warnings.push(
      "TRADING_MODE is full_auto — the engine MAY auto-execute when every gate passes.",
    );
  } else if (tradingMode === "advisor") {
    warnings.push(
      "TRADING_MODE is advisor — alerts only; the engine will NOT place any orders (enter manually in TopstepX).",
    );
  }
  if (config.safety.killSwitch) {
    warnings.push("KILL_SWITCH is engaged via env — ALL trading is blocked.");
  }
  if (
    config.notifications.enabled &&
    config.publicBaseUrl.includes("localhost")
  ) {
    warnings.push(
      "PHONE_NOTIFICATIONS_ENABLED is true but PUBLIC_BASE_URL is localhost — approve/reject links won't work from a phone. Set PUBLIC_BASE_URL to your deployed URL.",
    );
  }
  return warnings;
}
