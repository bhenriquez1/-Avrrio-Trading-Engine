import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AvrrioConfig } from "../config.js";

/**
 * Runtime-toggleable settings (persisted), so the operator can flip
 * paper/live from the dashboard without a redeploy. Defaults come from env and
 * stay SAFE (live trading off) until explicitly turned on.
 */
export class RuntimeSettings {
  private liveTrading: boolean;
  private schedulerEnabled: boolean;
  private schedulerIntervalMinutes: number;

  constructor(
    config: AvrrioConfig,
    private readonly path = "data/settings.json",
  ) {
    this.liveTrading = config.execution.liveTradingEnabled;
    this.schedulerEnabled = config.scheduler.enabled;
    this.schedulerIntervalMinutes = config.scheduler.intervalMinutes;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const data = JSON.parse(raw) as {
        liveTrading?: boolean;
        schedulerEnabled?: boolean;
        schedulerIntervalMinutes?: number;
      };
      if (typeof data.liveTrading === "boolean") this.liveTrading = data.liveTrading;
      if (typeof data.schedulerEnabled === "boolean")
        this.schedulerEnabled = data.schedulerEnabled;
      if (typeof data.schedulerIntervalMinutes === "number" && data.schedulerIntervalMinutes > 0)
        this.schedulerIntervalMinutes = data.schedulerIntervalMinutes;
    } catch {
      /* keep env defaults */
    }
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
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}
