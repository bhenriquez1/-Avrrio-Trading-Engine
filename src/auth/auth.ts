import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AvrrioConfig } from "../config.js";

/**
 * Minimal password gate for the dashboard.
 *
 * The operator logs in with DASHBOARD_PASSWORD and receives a bearer token held
 * in memory. All mutating/sensitive routes (approve, reject, kill switch,
 * generate) require a valid token. This protects the approval surface — nobody
 * can approve a live trade without the password.
 *
 * For a single-operator tool this in-memory scheme is appropriate. For
 * multi-user deployment, replace with real session storage + per-user accounts.
 */
export class Auth {
  private readonly tokens = new Set<string>();

  constructor(private readonly config: AvrrioConfig) {}

  get required(): boolean {
    return this.config.dashboard.password.length > 0;
  }

  /** Validate the password and issue a token. Returns null on failure. */
  login(password: string): string | null {
    if (!this.required) {
      // No password configured: issue a token but the dashboard is open.
      const open = randomBytes(24).toString("hex");
      this.tokens.add(open);
      return open;
    }
    if (!safeEqual(password, this.config.dashboard.password)) return null;
    const token = randomBytes(24).toString("hex");
    this.tokens.add(token);
    return token;
  }

  logout(token: string): void {
    this.tokens.delete(token);
  }

  isValid(token: string | undefined): boolean {
    if (!this.required) return true; // open mode
    return token !== undefined && this.tokens.has(token);
  }

  /** Express middleware guarding protected routes. */
  middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (!this.required) return next();
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (this.isValid(token)) return next();
    res.status(401).json({ error: "unauthorized" });
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
