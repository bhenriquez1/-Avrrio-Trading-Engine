import type { AvrrioConfig } from "../config.js";
import type { Recommendation } from "../execution/recommendations.js";

/**
 * The notification payload sent to every channel. Built from a recommendation
 * plus tokenized approve/reject links so the trade can be actioned from a phone
 * without logging in to the dashboard.
 */
export interface NotificationPayload {
  symbol: string;
  direction: string;
  entry: number;
  stop: number;
  target: number;
  riskAmount: number;
  confidence: number;
  newsStatus: string;
  expiresAt: string;
  approveUrl: string;
  rejectUrl: string;
}

export interface NotificationResult {
  channel: string;
  ok: boolean;
  info: string;
}

export interface NotificationChannel {
  readonly name: string;
  readonly enabled: boolean;
  send(payload: NotificationPayload): Promise<NotificationResult>;
}

export function buildPayload(
  config: AvrrioConfig,
  rec: Recommendation,
): NotificationPayload {
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const token = rec.approvalToken;
  return {
    symbol: rec.symbol,
    direction: rec.side,
    entry: rec.entry,
    stop: rec.stopLoss,
    target: rec.target,
    riskAmount: rec.riskAmount,
    confidence: rec.consensus.confidence,
    newsStatus: rec.news.blocked ? rec.news.reason : "clear",
    expiresAt: rec.expiresAt ?? "n/a",
    approveUrl: `${base}/api/approve-trade?id=${rec.id}&token=${token}`,
    rejectUrl: `${base}/api/reject-trade?id=${rec.id}&token=${token}`,
  };
}

/** Plain-text body shared by email/SMS/Telegram. */
export function renderText(p: NotificationPayload): string {
  return [
    `Avrrio setup: ${p.symbol} ${p.direction.toUpperCase()}`,
    `Entry ${p.entry} · Stop ${p.stop} · Target ${p.target}`,
    `Risk $${p.riskAmount.toFixed(0)} · Confidence ${(p.confidence * 100).toFixed(0)}%`,
    `News: ${p.newsStatus}`,
    `Valid until ${p.expiresAt}`,
    "",
    `Approve: ${p.approveUrl}`,
    `Reject:  ${p.rejectUrl}`,
  ].join("\n");
}

/**
 * Fans a notification out to every enabled channel. When phone notifications are
 * globally disabled, nothing is sent (returns an empty result set).
 */
export class NotificationManager {
  constructor(
    private readonly config: AvrrioConfig,
    private readonly channels: NotificationChannel[],
  ) {}

  get enabled(): boolean {
    return this.config.notifications.enabled && this.activeChannels().length > 0;
  }

  activeChannels(): string[] {
    return this.channels.filter((c) => c.enabled).map((c) => c.name);
  }

  async notify(rec: Recommendation): Promise<NotificationResult[]> {
    if (!this.config.notifications.enabled) return [];
    const payload = buildPayload(this.config, rec);
    const enabled = this.channels.filter((c) => c.enabled);
    return Promise.all(enabled.map((c) => c.send(payload)));
  }
}
