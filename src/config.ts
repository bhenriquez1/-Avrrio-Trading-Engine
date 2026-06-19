import "dotenv/config";

/**
 * Central configuration, loaded once from the environment.
 *
 * Safety-critical flags default to the SAFE value. Real trading requires the
 * operator to explicitly opt in via environment variables.
 */
export interface AvrrioConfig {
  topstep: {
    baseUrl: string;
    username: string;
    apiKey: string;
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
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function bool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === "true" || v === "1";
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(): AvrrioConfig {
  return {
    topstep: {
      baseUrl: env("TOPSTEP_API_BASE_URL", "https://api.topstepx.com"),
      username: env("TOPSTEP_USERNAME"),
      apiKey: env("TOPSTEP_API_KEY"),
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
  };
}

/**
 * Human-readable warnings about missing/unsafe configuration.
 * Surfaced in the dashboard and CLI so the operator always knows the engine's
 * safety posture.
 */
export function configWarnings(config: AvrrioConfig): string[] {
  const warnings: string[] = [];
  if (!config.topstep.apiKey || !config.topstep.username) {
    warnings.push(
      "TopstepX credentials are not set — running in OFFLINE/demo mode (no live market, account, or order routing).",
    );
  }
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
  if (config.execution.liveTradingEnabled) {
    warnings.push(
      "LIVE_TRADING_ENABLED is true — approved trades will be sent to TopstepX for real.",
    );
  } else {
    warnings.push(
      "LIVE_TRADING_ENABLED is false — approvals are simulated (paper). No real orders are sent.",
    );
  }
  if (config.execution.semiAutonomousEnabled) {
    warnings.push(
      "SEMI_AUTONOMOUS_ENABLED is true — the engine MAY auto-execute when every gate passes.",
    );
  }
  if (config.safety.killSwitch) {
    warnings.push("KILL_SWITCH is engaged via env — ALL trading is blocked.");
  }
  return warnings;
}
