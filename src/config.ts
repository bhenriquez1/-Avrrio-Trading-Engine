import "dotenv/config";

/**
 * Central configuration, loaded once from the environment.
 *
 * Safety note: `allowLiveOrders` exists only so the value is explicit and
 * auditable. Nothing in this codebase places orders — the trading engine is a
 * read-only analyst + risk manager in this phase.
 */
export interface AvrrioConfig {
  topstep: {
    baseUrl: string;
    username: string;
    apiKey: string;
  };
  claude: {
    apiKey: string;
    model: string;
  };
  /** Always false in this phase. See README "Safety model". */
  allowLiveOrders: boolean;
  dashboardPort: number;
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(): AvrrioConfig {
  return {
    topstep: {
      baseUrl: env("TOPSTEP_API_BASE_URL", "https://api.topstepx.com"),
      username: env("TOPSTEP_USERNAME"),
      apiKey: env("TOPSTEP_API_KEY"),
    },
    claude: {
      apiKey: env("ANTHROPIC_API_KEY"),
      model: env("AVRRIO_CLAUDE_MODEL", "claude-opus-4-8"),
    },
    allowLiveOrders: env("AVRRIO_ALLOW_LIVE_ORDERS", "false") === "true",
    dashboardPort: Number(env("DASHBOARD_PORT", "4317")),
  };
}

/**
 * Returns a list of human-readable warnings for missing/unsafe configuration.
 * Used by the dashboard and CLI so the operator knows what is and isn't wired.
 */
export function configWarnings(config: AvrrioConfig): string[] {
  const warnings: string[] = [];
  if (!config.topstep.apiKey || !config.topstep.username) {
    warnings.push(
      "TopstepX credentials are not set — running in OFFLINE/demo mode (no live market or account data).",
    );
  }
  if (!config.claude.apiKey) {
    warnings.push(
      "ANTHROPIC_API_KEY is not set — Claude analysis is disabled; the engine will only report rule checks.",
    );
  }
  if (config.allowLiveOrders) {
    warnings.push(
      "AVRRIO_ALLOW_LIVE_ORDERS is true, but live order placement is NOT implemented in this phase. No orders will be sent.",
    );
  }
  return warnings;
}
