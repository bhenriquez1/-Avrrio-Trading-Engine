import type { AvrrioConfig } from "../config.js";

export interface SmsSendResult {
  ok: boolean;
  info: string;
  /** Specific env vars missing (empty when fully configured). */
  missing?: string[];
}

/**
 * Returns the exact Twilio/SMS env vars that are missing. Returns an empty
 * list when SMS is intentionally disabled (SMS_ENABLED=false) — no Twilio
 * vars are required in that case.
 */
export function smsMissing(config: AvrrioConfig): string[] {
  const s = config.notifications.sms;
  if (!s.enabled) return [];
  const missing: string[] = [];
  if (!s.twilioAccountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!s.twilioAuthToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!s.fromNumber) missing.push("TWILIO_FROM_NUMBER");
  if (!s.toNumber) missing.push("ALERT_PHONE_NUMBER");
  return missing;
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
  if (!s.enabled) {
    return { ok: false, info: "SMS is disabled (SMS_ENABLED=false)." };
  }
  if (s.provider !== "twilio") {
    return { ok: false, info: `Unsupported SMS provider "${s.provider}".` };
  }
  const missing = smsMissing(config);
  if (missing.length > 0) {
    return {
      ok: false,
      info: `SMS not configured — missing: ${missing.join(", ")}.`,
      missing,
    };
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
