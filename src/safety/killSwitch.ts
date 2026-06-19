import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AvrrioConfig } from "../config.js";
import type { AuditLog } from "../audit/auditLog.js";

interface KillSwitchState {
  engaged: boolean;
  reason: string;
  actor: string;
  at: string;
}

/**
 * Emergency kill switch. When engaged, every order is blocked.
 *
 * State is persisted to disk so a trip survives a restart, and can also be
 * forced on via the KILL_SWITCH env var (which can never be cleared at runtime).
 */
export class KillSwitch {
  private state: KillSwitchState = {
    engaged: false,
    reason: "",
    actor: "",
    at: "",
  };

  constructor(
    private readonly config: AvrrioConfig,
    private readonly audit: AuditLog,
    private readonly path = "data/kill-switch.json",
  ) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      this.state = JSON.parse(raw) as KillSwitchState;
    } catch {
      /* default: not engaged */
    }
  }

  /** True if engaged via env (immovable) or at runtime. */
  isEngaged(): boolean {
    return this.config.safety.killSwitch || this.state.engaged;
  }

  status(): KillSwitchState & { envForced: boolean } {
    return { ...this.state, envForced: this.config.safety.killSwitch };
  }

  async engage(reason: string, actor: string): Promise<void> {
    this.state = {
      engaged: true,
      reason,
      actor,
      at: new Date().toISOString(),
    };
    await this.persist();
    await this.audit.log("kill_switch.engaged", actor, { reason });
  }

  async disengage(actor: string): Promise<boolean> {
    if (this.config.safety.killSwitch) {
      // Env-forced kill switch cannot be cleared at runtime.
      await this.audit.log("kill_switch.disengage_denied", actor, {
        reason: "KILL_SWITCH env is true",
      });
      return false;
    }
    this.state = { engaged: false, reason: "", actor, at: new Date().toISOString() };
    await this.persist();
    await this.audit.log("kill_switch.disengaged", actor, {});
    return true;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.state, null, 2), "utf8");
  }
}
