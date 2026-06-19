import type { AvrrioConfig } from "../config.js";

export interface NewsEvent {
  title: string;
  /** ISO timestamp of the event. */
  time: string;
  impact: "low" | "medium" | "high";
  /** Affected symbols/currencies, best-effort. */
  symbols: string[];
}

export interface NewsRisk {
  blocked: boolean;
  reason: string;
  events: NewsEvent[];
}

/**
 * News reader. Pulls economic/news events from an approved source and reports
 * whether high-impact news sits near a prospective trade window.
 *
 * In offline mode (no NEWS_API_URL) it returns "no events" but can be forced via
 * a manual override on the risk check. The AI consensus layer can also reason
 * about a news headline, but this module is the deterministic time-window guard.
 */
export class NewsReader {
  private readonly url: string;

  constructor(_config: AvrrioConfig) {
    this.url = process.env.NEWS_API_URL ?? "";
  }

  get enabled(): boolean {
    return this.url.length > 0;
  }

  async upcoming(): Promise<NewsEvent[]> {
    if (!this.enabled) return [];
    try {
      const res = await fetch(this.url);
      if (!res.ok) return [];
      const data = (await res.json()) as NewsEvent[];
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  /**
   * Returns a block decision if a high-impact event affecting `symbol` falls
   * within `windowMinutes` of now.
   */
  async assess(symbol: string, windowMinutes = 15): Promise<NewsRisk> {
    const events = await this.upcoming();
    const now = Date.now();
    const windowMs = windowMinutes * 60_000;
    const sym = symbol.toUpperCase();

    const near = events.filter((e) => {
      if (e.impact !== "high") return false;
      const t = new Date(e.time).getTime();
      if (Math.abs(t - now) > windowMs) return false;
      return (
        e.symbols.length === 0 ||
        e.symbols.some((s) => sym.includes(s.toUpperCase()))
      );
    });

    return near.length > 0
      ? {
          blocked: true,
          reason: `High-impact news within ${windowMinutes} min: ${near
            .map((e) => e.title)
            .join("; ")}`,
          events: near,
        }
      : { blocked: false, reason: "No high-impact news in window.", events: [] };
  }
}
