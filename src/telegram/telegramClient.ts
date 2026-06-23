/**
 * Thin Telegram Bot API client (no dependency). All calls return a parsed
 * result object; failures are caught and reported, never thrown.
 */
export interface TgResult {
  ok: boolean;
  info: string;
  data?: unknown;
  /** Which TELEGRAM_* settings are missing/unset (set on a config error). */
  missing?: string[];
  /** HTTP status from the Telegram API (when a request was made). */
  httpStatus?: number;
  /** Telegram's error_code (e.g. 404, 401) when ok=false. */
  errorCode?: number;
  /** Telegram's human-readable description when ok=false. */
  description?: string;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

const API = (token: string, method: string) =>
  `https://api.telegram.org/bot${token}/${method}`;

/**
 * A valid Telegram bot token is `<bot_id>:<secret>` — digits, a colon, then the
 * secret (e.g. `123456789:AA...`). A token missing the numeric `id:` prefix is
 * the usual cause of a 404 "Not Found" from the API.
 */
export function isValidBotTokenShape(token: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{20,}$/.test(token.trim());
}

export async function tgSendMessage(
  token: string,
  chatId: string,
  text: string,
  buttons?: InlineButton[][],
): Promise<TgResult> {
  return call(token, "sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
  });
}

export async function tgAnswerCallback(
  token: string,
  callbackQueryId: string,
  text: string,
): Promise<TgResult> {
  return call(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text.slice(0, 200),
    show_alert: false,
  });
}

export async function tgEditReplyMarkup(
  token: string,
  chatId: string | number,
  messageId: number,
): Promise<TgResult> {
  // Clears the inline keyboard so a decided alert can't be tapped again.
  return call(token, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  });
}

export async function tgGetUpdates(token: string): Promise<TgResult> {
  return call(token, "getUpdates", {});
}

export async function tgSetWebhook(
  token: string,
  url: string,
  secretToken?: string,
): Promise<TgResult> {
  return call(token, "setWebhook", {
    url,
    allowed_updates: ["callback_query", "message"],
    ...(secretToken ? { secret_token: secretToken } : {}),
  });
}

async function call(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<TgResult> {
  const trimmed = token.trim();
  // Fail fast on a malformed token so we don't fire a doomed request whose only
  // signal is a bare 404. (Never include the token value in the message.)
  if (!isValidBotTokenShape(trimmed)) {
    return {
      ok: false,
      info: "Invalid bot token format — expected <bot_id>:<secret> (e.g. 123456789:AA...). Set TELEGRAM_BOT_TOKEN in Render to the FULL token including the numeric id before the colon.",
    };
  }
  try {
    const res = await fetch(API(trimmed, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error_code?: number;
      description?: string;
      result?: unknown;
    };
    if (res.ok && data.ok !== false) {
      return { ok: true, info: "ok", data: data.result, httpStatus: res.status };
    }
    const errorCode = data.error_code ?? res.status;
    const description = data.description ?? `HTTP ${res.status}`;
    // A 404 from this endpoint almost always means the bot token is wrong.
    const info =
      res.status === 404 || errorCode === 404
        ? "Invalid bot token or malformed Telegram API URL."
        : `Telegram error ${errorCode}: ${description}`;
    return {
      ok: false,
      info,
      data: data.result,
      httpStatus: res.status,
      errorCode,
      description,
    };
  } catch (err) {
    return { ok: false, info: err instanceof Error ? err.message : "failed" };
  }
}
