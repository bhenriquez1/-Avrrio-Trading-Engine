import type { AvrrioConfig } from "../config.js";
import type { Recommendation } from "../execution/recommendations.js";
import { findSymbol } from "../symbols/registry.js";
import {
  tgAnswerCallback,
  tgEditReplyMarkup,
  tgGetUpdates,
  tgSendMessage,
  tgSetWebhook,
  type InlineButton,
  type TgResult,
} from "./telegramClient.js";

/** Callback codes kept short (Telegram callback_data max 64 bytes). */
const APPROVE = "a";
const REJECT = "r";
const STOPALL = "x";
const DETAILS = "d";

export interface TelegramCallback {
  callbackQueryId: string;
  chatId: string;
  messageId: number;
  data: string;
}

/** Action applied for a tapped button, returning the operator confirmation text. */
export type ApprovalActor = (
  action: "approve" | "reject" | "stopall" | "details",
  ref: string,
) => Promise<string>;

/**
 * Telegram alert service — the primary alert channel. Sends rich, one-tap
 * APPROVE / REJECT / DETAILS / EMERGENCY STOP alerts and processes button
 * presses (authorized by chat id). SMS is not used as a fallback.
 */
export class TelegramService {
  constructor(private readonly config: AvrrioConfig) {}

  get enabled(): boolean {
    const t = this.config.notifications.telegram;
    return t.enabled && t.botToken.length > 0 && t.chatId.length > 0;
  }

  private get token(): string {
    return this.config.notifications.telegram.botToken;
  }
  private get chatId(): string {
    return this.config.notifications.telegram.chatId;
  }

  /** Sends the 🚨 alert with inline APPROVE / REJECT / STOP ALL buttons. */
  async sendAlert(rec: Recommendation): Promise<TgResult> {
    if (!this.enabled) return { ok: false, info: "telegram not configured" };
    const buttons: InlineButton[][] = [
      [
        { text: "✅ APPROVE", callback_data: `${APPROVE}|${rec.ref}` },
        { text: "❌ REJECT", callback_data: `${REJECT}|${rec.ref}` },
      ],
      [{ text: "📋 DETAILS", callback_data: `${DETAILS}|${rec.ref}` }],
      [{ text: "🛑 EMERGENCY STOP", callback_data: STOPALL }],
    ];
    return tgSendMessage(this.token, this.chatId, formatAlert(rec), buttons);
  }

  async sendTest(): Promise<TgResult> {
    if (!this.enabled) {
      return {
        ok: false,
        info: "Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.",
      };
    }
    return tgSendMessage(
      this.token,
      this.chatId,
      "✅ Avrrio Trade AI — Telegram test alert successful.",
    );
  }

  async sendText(text: string): Promise<TgResult> {
    if (!this.enabled) return { ok: false, info: "telegram not configured" };
    return tgSendMessage(this.token, this.chatId, text);
  }

  /** Registers the webhook so Telegram delivers button presses to our endpoint. */
  async setWebhook(url: string, secret?: string): Promise<TgResult> {
    if (!this.token) return { ok: false, info: "no bot token" };
    return tgSetWebhook(this.token, url, secret);
  }

  /**
   * Calls getUpdates and extracts the distinct chat_id values found, so the
   * operator can discover their TELEGRAM_CHAT_ID. (Does not expose the token.)
   */
  async debug(): Promise<{ ok: boolean; info: string; chatIds: string[] }> {
    if (!this.token) {
      return { ok: false, info: "TELEGRAM_BOT_TOKEN not set.", chatIds: [] };
    }
    const r = await tgGetUpdates(this.token);
    if (!r.ok) return { ok: false, info: r.info, chatIds: [] };
    const updates = (r.data as TelegramUpdate[]) ?? [];
    const ids = new Set<string>();
    for (const u of updates) {
      const chat =
        u.message?.chat ?? u.callback_query?.message?.chat ?? u.my_chat_member?.chat;
      if (chat?.id != null) ids.add(String(chat.id));
    }
    return {
      ok: true,
      info: ids.size
        ? `Found chat id(s): ${[...ids].join(", ")}. Set TELEGRAM_CHAT_ID to yours.`
        : "No updates yet — message your bot once, then retry.",
      chatIds: [...ids],
    };
  }

  /** Parses an inbound webhook body into a TelegramCallback, if it is one. */
  parseCallback(body: unknown): TelegramCallback | null {
    const update = body as TelegramUpdate;
    const cq = update?.callback_query;
    if (!cq || !cq.message) return null;
    return {
      callbackQueryId: cq.id,
      chatId: String(cq.message.chat.id),
      messageId: cq.message.message_id,
      data: cq.data ?? "",
    };
  }

  /**
   * Handles a button press: authorizes the chat, runs the action through the
   * provided actor (which enforces all safety gates), acknowledges the tap, and
   * clears the buttons. Returns the confirmation text.
   */
  async handleCallback(
    cb: TelegramCallback,
    actor: ApprovalActor,
  ): Promise<string> {
    if (cb.chatId !== this.chatId) {
      await tgAnswerCallback(this.token, cb.callbackQueryId, "Unauthorized.");
      return "unauthorized";
    }
    const [code, ref = ""] = cb.data.split("|");
    let text: string;
    if (code === APPROVE) text = await actor("approve", ref);
    else if (code === REJECT) text = await actor("reject", ref);
    else if (code === DETAILS) text = await actor("details", ref);
    else if (code === STOPALL) text = await actor("stopall", "");
    else text = "Unknown action.";

    await tgAnswerCallback(this.token, cb.callbackQueryId, text);
    if (code !== DETAILS) {
      await tgEditReplyMarkup(this.token, cb.chatId, cb.messageId); // disable buttons after final actions
    }
    await tgSendMessage(this.token, this.chatId, text);
    return text;
  }
}

export function formatAlert(rec: Recommendation): string {
  const riskPts = Math.abs(rec.entry - rec.stopLoss);
  const rewardPts = Math.abs(rec.target - rec.entry);
  const rr = riskPts > 0 ? (rewardPts / riskPts).toFixed(1) : "n/a";
  const assetClass = findSymbol(rec.symbol)?.assetClass ?? "futures";
  return [
    "🚨 AVRRIO ALERT",
    "",
    `Trade ID: ${rec.ref}`,
    "",
    `${rec.symbol} ${assetClass}`,
    rec.side.toUpperCase(),
    "",
    `Entry: ${rec.entry}`,
    `Stop: ${rec.stopLoss}`,
    `Target: ${rec.target}`,
    `Size: ${rec.size}`,
    "",
    `Risk/Reward: ${rr}`,
    `Confidence: ${(rec.consensus.confidence * 100).toFixed(0)}%`,
    `Avrrio Score: ${rec.avrrioScore ?? "n/a"}`,
  ].join("\n");
}

// --- minimal Telegram update shapes we read ---
interface TgChat {
  id: number | string;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
}
interface TelegramUpdate {
  message?: { chat: TgChat };
  my_chat_member?: { chat: TgChat };
  callback_query?: {
    id: string;
    data?: string;
    message?: TgMessage;
  };
}
