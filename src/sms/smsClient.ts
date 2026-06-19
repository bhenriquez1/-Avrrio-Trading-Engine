import type { AvrrioConfig } from "../config.js";

export interface SmsSendResult {
  ok: boolean;
  info: string;
}

/**
 * Shared SMS sender (Twilio). Used by alerts, approval confirmations, and the
 * test endpoint. Sends to `to` (defaults to the configured authorized number).
 * No-ops with a clear message when SMS is not fully configured.
 */
export async function sendSms(
  config: AvrrioConfig,
  body: string,
  to?: string,
): Promise<SmsSendResult> {
  const s = config.notifications.sms;
  const recipient = to ?? s.toNumber;
  if (s.provider !== "twilio") {
    return { ok: false, info: `Unsupported SMS provider "${s.provider}".` };
  }
  if (!s.twilioAccountSid || !s.twilioAuthToken || !s.fromNumber || !recipient) {
    return { ok: false, info: "SMS not configured (missing Twilio settings or number)." };
  }
  try {
    const form = new URLSearchParams({
      To: recipient,
      From: s.fromNumber,
      Body: body,
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
        body: form.toString(),
      },
    );
    return { ok: res.ok, info: res.ok ? "sent" : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, info: err instanceof Error ? err.message : "failed" };
  }
}

/** Normalizes phone numbers for comparison (digits only, keep trailing). */
export function samePhone(a: string, b: string): boolean {
  const d = (x: string) => x.replace(/[^\d]/g, "");
  const da = d(a);
  const db = d(b);
  if (!da || !db) return false;
  // Compare last 10 digits to tolerate +1 / country-code differences.
  return da.slice(-10) === db.slice(-10);
}
