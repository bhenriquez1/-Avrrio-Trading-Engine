import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AvrrioConfig } from "../config.js";
import { parseTradingMode, type TradingMode } from "../types.js";

/** Operator-completed safety validations (persisted, survive restarts). */
export interface SafetyValidations {
  telegramTestPassed: boolean;
  emergencyStopTested: boolean;
  paperApprovalTestPassed: boolean;
}

export type SafetyValidationKey = keyof SafetyValidations;

const EMPTY_VALIDATIONS: SafetyValidations = {
  telegramTestPassed: false,
  emergencyStopTested: false,
  paperApprovalTestPassed: false,
};

/**
 * Runtime-toggleable settings (persisted), so the operator can flip
 * paper/live from the dashboard without a redeploy. Defaults come from env and
 * stay SAFE (live trading off) until explicitly turned on.
 */
export class RuntimeSettings {
  private liveTrading: boolean;
  private schedulerEnabled: boolean;
  private schedulerIntervalMinutes: number;
  private tradingMode: TradingMode;
  private validations: SafetyValidations = { ...EMPTY_VALIDATIONS };

  constructor(
    config: AvrrioConfig,
    private readonly path = "data/settings.json",
  ) {
    this.liveTrading = config.execution.liveTradingEnabled;
    this.schedulerEnabled = config.scheduler.enabled;
    this.schedulerIntervalMinutes = config.scheduler.intervalMinutes;
    this.tradingMode = config.execution.tradingMode;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const data = JSON.parse(raw) as {
        liveTrading?: boolean;
        schedulerEnabled?: boolean;
        schedulerIntervalMinutes?: number;
        tradingMode?: string;
        validations?: Partial<SafetyValidations>;
      };
      if (typeof data.liveTrading === "boolean") this.liveTrading = data.liveTrading;
      if (typeof data.schedulerEnabled === "boolean")
        this.schedulerEnabled = data.schedulerEnabled;
      if (typeof data.schedulerIntervalMinutes === "number" && data.schedulerIntervalMinutes > 0)
        this.schedulerIntervalMinutes = data.schedulerIntervalMinutes;
      if (typeof data.tradingMode === "string")
        this.tradingMode = parseTradingMode(data.tradingMode);
      if (data.validations && typeof data.validations === "object") {
        for (const k of Object.keys(EMPTY_VALIDATIONS) as SafetyValidationKey[]) {
          if (typeof data.validations[k] === "boolean")
            this.validations[k] = data.validations[k] as boolean;
        }
      }
    } catch {
      /* keep env defaults */
    }
  }

  /** Snapshot of the persisted safety validations. */
  getValidations(): SafetyValidations {
    return { ...this.validations };
  }
  /** Mark a validation as passed (persisted). Idempotent. */
  async markValidation(key: SafetyValidationKey): Promise<void> {
    if (this.validations[key]) return;
    this.validations[key] = true;
    await this.persist();
  }
  /** Clear all safety validations so they must be re-verified (persisted). */
  async resetValidations(): Promise<void> {
    this.validations = { ...EMPTY_VALIDATIONS };
    await this.persist();
  }

  getTradingMode(): TradingMode {
    return this.tradingMode;
  }
  async setTradingMode(mode: TradingMode): Promise<void> {
    this.tradingMode = mode;
    await this.persist();
  }

  isLiveTradingEnabled(): boolean {
    return this.liveTrading;
  }
  async setLiveTrading(enabled: boolean): Promise<void> {
    this.liveTrading = enabled;
    await this.persist();
  }

  isSchedulerEnabled(): boolean {
    return this.schedulerEnabled;
  }
  getSchedulerInterval(): number {
    return this.schedulerIntervalMinutes;
  }
  async setScheduler(enabled: boolean, intervalMinutes?: number): Promise<void> {
    this.schedulerEnabled = enabled;
    if (intervalMinutes && intervalMinutes > 0)
      this.schedulerIntervalMinutes = intervalMinutes;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(
      this.path,
      JSON.stringify(
        {
          liveTrading: this.liveTrading,
          schedulerEnabled: this.schedulerEnabled,
          schedulerIntervalMinutes: this.schedulerIntervalMinutes,
          tradingMode: this.tradingMode,
          validations: this.validations,
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}
