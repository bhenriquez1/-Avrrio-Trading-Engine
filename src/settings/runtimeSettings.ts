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

  constructor(
    config: AvrrioConfig,
    private readonly path = "data/settings.json",
  ) {
    this.liveTrading = config.execution.liveTradingEnabled;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const data = JSON.parse(raw) as { liveTrading?: boolean };
      if (typeof data.liveTrading === "boolean") this.liveTrading = data.liveTrading;
    } catch {
      /* keep env default */
    }
  }

  isLiveTradingEnabled(): boolean {
    return this.liveTrading;
  }

  async setLiveTrading(enabled: boolean): Promise<void> {
    this.liveTrading = enabled;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(
      this.path,
      JSON.stringify({ liveTrading: this.liveTrading }, null, 2),
      "utf8",
    );
  }
}
