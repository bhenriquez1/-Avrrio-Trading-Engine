import type { AvrrioConfig } from "../config.js";
import type { Recommendation } from "../execution/recommendations.js";
import { findSymbol } from "../symbols/registry.js";
import {
  isValidBotTokenShape,
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

  /**
   * Exactly which of the THREE required settings are missing/unset, so the
   * "not configured" reason is precise. Note TELEGRAM_ENABLED=true is required
   * in addition to the token + chat id — a common gotcha when only the latter
   * two are set in the host environment.
   */
  missing(): string[] {
    const t = this.config.notifications.telegram;
    const missing: string[] = [];
    if (!t.enabled) missing.push("TELEGRAM_ENABLED=true");
    if (!t.botToken) missing.push("TELEGRAM_BOT_TOKEN");
    if (!t.chatId) missing.push("TELEGRAM_CHAT_ID");
    return missing;
  }

  /** Debug-safe presence map (never exposes the token/chat-id values). */
  presence(): Record<string, string> {
    const t = this.config.notifications.telegram;
    const tokenShape = !t.botToken
      ? maskSecret(t.botToken)
      : isValidBotTokenShape(t.botToken)
        ? `${maskSecret(t.botToken)} — format OK`
        : `${maskSecret(t.botToken)} — INVALID format (need <bot_id>:<secret>)`;
    return {
      TELEGRAM_ENABLED: t.enabled ? "true" : "false (must be true)",
      TELEGRAM_BOT_TOKEN: tokenShape,
      TELEGRAM_CHAT_ID: t.chatId ? "set" : "missing",
    };
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
      const missing = this.missing();
      // Debug-safe log (no values) so the host logs show the exact reason.
      console.warn(`[telegram] not configured — missing/unset: ${missing.join(", ")}`);
      return {
        ok: false,
        info: `Telegram not configured — missing/unset: ${missing.join(", ")}.`,
        missing,
      };
    }
    if (!isValidBotTokenShape(this.token)) {
      console.warn("[telegram] bot token malformed (expected <bot_id>:<secret>)");
      return {
        ok: false,
        info: "Invalid bot token format — TELEGRAM_BOT_TOKEN must be <bot_id>:<secret> (e.g. 123456789:AA...). The numeric id before the colon appears to be missing; set the FULL token from BotFather in Render.",
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
  async debug(): Promise<{
    ok: boolean;
    info: string;
    chatIds: string[];
    presence: Record<string, string>;
    missing: string[];
    enabled: boolean;
  }> {
    const presence = this.presence();
    const missing = this.missing();
    const base = { presence, missing, enabled: this.enabled };
    if (!this.token) {
      return {
        ok: false,
        info: `TELEGRAM_BOT_TOKEN not set. Missing/unset: ${missing.join(", ") || "none"}.`,
        chatIds: [],
        ...base,
      };
    }
    const r = await tgGetUpdates(this.token);
    if (!r.ok) return { ok: false, info: r.info, chatIds: [], ...base };
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
      ...base,
    };
  }

  /** Parses an inbound text message (command) from a webhook body, if present. */
  parseMessage(body: unknown): { chatId: string; text: string } | null {
    const update = body as TelegramUpdate;
    const m = update?.message;
    if (!m || typeof m.text !== "string" || m.text.trim() === "") return null;
    return { chatId: String(m.chat.id), text: m.text };
  }

  /** True only for the single configured (authorized) chat id. */
  isAuthorized(chatId: string): boolean {
    return this.chatId.length > 0 && chatId === this.chatId;
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
    `AI Consensus: ${(rec.consensus.confidence * 100).toFixed(0)}%`,
    `Avrrio Score: ${rec.avrrioScore ?? "n/a"}`,
    "",
    ...(rec.grade
      ? [
          `Confidence: ${rec.grade.confidence}%`,
          `Grade: ${rec.grade.grade}`,
          `Trend: ${Math.round(rec.grade.breakdown.trend)} · Momentum: ${Math.round(rec.grade.breakdown.momentum)} · Volume: ${Math.round(rec.grade.breakdown.volume)} · Structure: ${Math.round(rec.grade.breakdown.structure)}`,
          `Risk: ${rec.grade.riskApproved ? "Approved" : "Blocked"}`,
          "",
        ]
      : []),
    `Setup: ${rec.setupName ?? "scanner signal"}`,
    `Why allowed: ${rec.riskApproved ? "risk checks passed" : "see review"} · news ${rec.news?.blocked ? "BLOCKED" : "clear"} · consensus ${rec.consensus.recommendation}`,
    ...(rec.violations && rec.violations.length
      ? [`Notes: ${rec.violations.map((v) => v.message).join("; ")}`]
      : []),
  ].join("\n");
}

/** Masks a secret: "set (ab…yz)" showing only first/last 2 chars, or "missing". */
function maskSecret(v: string): string {
  if (!v) return "missing";
  if (v.length <= 4) return "set (****)";
  return `set (${v.slice(0, 2)}…${v.slice(-2)})`;
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
  message?: { chat: TgChat; text?: string };
  my_chat_member?: { chat: TgChat };
  callback_query?: {
    id: string;
    data?: string;
    message?: TgMessage;
  };
}
