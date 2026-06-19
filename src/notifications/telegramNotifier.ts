import type { AvrrioConfig } from "../config.js";
import {
  renderText,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationResult,
} from "./notifier.js";

/** Sends setup alerts via a Telegram bot (recommended first channel: fast, free). */
export class TelegramNotifier implements NotificationChannel {
  readonly name = "telegram";

  constructor(private readonly config: AvrrioConfig) {}

  get enabled(): boolean {
    const t = this.config.notifications.telegram;
    return t.enabled && t.botToken.length > 0 && t.chatId.length > 0;
  }

  async send(payload: NotificationPayload): Promise<NotificationResult> {
    const t = this.config.notifications.telegram;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${t.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: t.chatId,
            text: renderText(payload),
            disable_web_page_preview: true,
          }),
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
