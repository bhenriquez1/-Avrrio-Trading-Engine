import type { AvrrioConfig } from "../config.js";
import {
  renderText,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationResult,
} from "./notifier.js";

/**
 * Sends setup alerts by email via the SendGrid v3 API (no extra dependency).
 * Enabled by default, but only actually sends when a SendGrid key and recipient
 * are configured. (SMTP support can be added later behind the same interface.)
 */
export class EmailNotifier implements NotificationChannel {
  readonly name = "email";

  constructor(private readonly config: AvrrioConfig) {}

  get enabled(): boolean {
    const e = this.config.notifications.email;
    return e.enabled && e.sendgridApiKey.length > 0 && e.to.length > 0;
  }

  async send(payload: NotificationPayload): Promise<NotificationResult> {
    const e = this.config.notifications.email;
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          authorization: `Bearer ${e.sendgridApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: e.to }] }],
          from: { email: e.from },
          subject: `Avrrio setup: ${payload.symbol} ${payload.direction.toUpperCase()}`,
          content: [{ type: "text/plain", value: renderText(payload) }],
        }),
      });
      return {
        channel: this.name,
        ok: res.ok,
        info: res.ok ? "sent" : `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        channel: this.name,
        ok: false,
        info: err instanceof Error ? err.message : "failed",
      };
    }
  }
}
