import type { AvrrioConfig } from "../config.js";
import {
  renderText,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationResult,
} from "./notifier.js";

/**
 * Sends setup alerts via Twilio SMS. Disabled by default (SMS_ENABLED=false) —
 * Telegram is the recommended first channel; add SMS later. Uses the Twilio REST
 * API directly (form-encoded), no extra dependency.
 */
export class SmsNotifier implements NotificationChannel {
  readonly name = "sms";

  constructor(private readonly config: AvrrioConfig) {}

  get enabled(): boolean {
    const s = this.config.notifications.sms;
    return (
      s.enabled &&
      s.twilioAccountSid.length > 0 &&
      s.twilioAuthToken.length > 0 &&
      s.fromNumber.length > 0 &&
      s.toNumber.length > 0
    );
  }

  async send(payload: NotificationPayload): Promise<NotificationResult> {
    const s = this.config.notifications.sms;
    try {
      const body = new URLSearchParams({
        To: s.toNumber,
        From: s.fromNumber,
        Body: renderText(payload),
      });
      const auth = Buffer.from(
        `${s.twilioAccountSid}:${s.twilioAuthToken}`,
      ).toString("base64");
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${s.twilioAccountSid}/Messages.json`,
        {
          method: "POST",
          headers: {
            authorization: `Basic ${auth}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: body.toString(),
        },
      );
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
