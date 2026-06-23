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
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

const API = (token: string, method: string) =>
  `https://api.telegram.org/bot${token}/${method}`;

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
  try {
    const res = await fetch(API(token, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      description?: string;
      result?: unknown;
    };
    return {
      ok: res.ok && data.ok !== false,
      info: data.ok === false ? data.description ?? `HTTP ${res.status}` : "ok",
      data: data.result,
    };
  } catch (err) {
    return { ok: false, info: err instanceof Error ? err.message : "failed" };
  }
}
