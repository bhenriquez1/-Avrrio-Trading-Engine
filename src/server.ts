import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AvrrioEngine, type ProposeInput } from "./engine.js";
import { SYMBOLS, type AssetClass } from "./symbols/registry.js";
import { parseTradingMode } from "./types.js";

/**
 * Dashboard + API server.
 *
 * Stability: every async route is wrapped so a thrown error always produces a
 * JSON response instead of hanging the request (which is what surfaced as a 502
 * with an HTML error page the frontend then failed to parse). A lightweight
 * /api/health endpoint does no external I/O and is used for platform health checks.
 */
const here = dirname(fileURLToPath(import.meta.url));

/** Wraps an async handler so rejections flow to the error middleware. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).catch(next);

async function start() {
  const engine = new AvrrioEngine();
  await engine.init();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false })); // Twilio inbound webhooks

  // Health check — no external I/O, never 502s.
  app.get(["/api/health", "/healthz"], (_req, res) => {
    res.json({ ok: true, service: "avrrio-trading-engine", time: new Date().toISOString() });
  });

  app.use(express.static(join(here, "dashboard", "public")));

  // --- auth -------------------------------------------------------------
  app.post("/api/login", (req, res) => {
    const { password } = req.body as { password?: string };
    const token = engine.auth.login(password ?? "");
    if (!token) {
      res.status(401).json({ error: "invalid password" });
      return;
    }
    res.json({ token });
  });

  const guard = engine.auth.middleware;

  // --- status & data ----------------------------------------------------
  // Exempt from the password gate: read-only/diagnostic endpoints that expose
  // NO secrets and cannot change trading state or place orders. This keeps the
  // dashboard's status panel and connection diagnostics working even before
  // login / across restarts. State-changing routes below stay guarded.
  app.get(
    "/api/status",
    wrap(async (_req, res) => {
      // Resilient: a broker/network failure must not 502 the whole dashboard.
      let account = null;
      let accountError: string | null = null;
      try {
        account = await engine.getAccount();
      } catch (err) {
        accountError = err instanceof Error ? err.message : "account unavailable";
      }
      res.json({
        account,
        accountError,
        offline: engine.client.isOffline,
        liveTrading: engine.isLiveTradingEnabled(),
        tradingMode: engine.getTradingMode(),
        semiAutonomous: engine.getTradingMode() === "full_auto",
        killSwitch: engine.killSwitch.status(),
        topstepx: engine.topstepxStatus(),
        liveTradingChecklist: await engine.liveTradingChecklist(false),
        providers: engine.consensus.availableProviders(),
        ai: engine.aiHealth(),
        newsEnabled: engine.news.enabled,
        notifications: {
          enabled: engine.notifications.enabled,
          channels: engine.notifications.activeChannels(),
          smsEnabled: engine.config.notifications.sms.enabled,
          smsMissing: engine.smsMissing(),
          telegramEnabled: engine.telegram.enabled,
          telegramPresence: engine.telegram.presence(),
          telegramMissing: engine.telegram.missing(),
          primaryChannel: engine.telegram.enabled
            ? "telegram"
            : engine.config.notifications.sms.enabled
              ? "sms"
              : "none",
        },
        approvalExpiryMinutes: engine.config.queue.approvalExpiryMinutes,
        scheduler: engine.scheduler.stats(),
        warnings: engine.warnings(),
        journalStats: engine.journal.stats(),
        safety: engine.config.safety,
      });
    }),
  );

  app.get("/api/recommendations", guard, (_req, res) => {
    res.json(engine.recommendations.list());
  });

  app.get(
    "/api/audit",
    guard,
    wrap(async (_req, res) => res.json(await engine.audit.recent(100))),
  );

  app.get(
    "/api/snapshot/:symbol",
    guard,
    wrap(async (req, res) => res.json(await engine.snapshot(req.params.symbol ?? ""))),
  );

  app.get("/api/symbols", guard, (_req, res) => res.json(SYMBOLS));

  app.get(
    "/api/scan",
    guard,
    wrap(async (req, res) => {
      const classesParam = String(req.query.classes ?? "");
      const classes = classesParam
        ? (classesParam.split(",").filter(Boolean) as AssetClass[])
        : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const results = await engine.scan({ classes, limit });
      // Alert on the top opportunity if it clears the alert threshold.
      const top = results[0];
      if (top && top.tradable) {
        await engine.alertOpportunity({
          symbol: top.symbol,
          direction: top.direction,
          score: top.score,
          confidence: top.confidence,
        });
      }
      res.json(results);
    }),
  );

  // --- workflow (protected) --------------------------------------------
  app.post(
    "/api/propose",
    guard,
    wrap(async (req, res) => res.json(await engine.propose(req.body as ProposeInput))),
  );

  app.post(
    "/api/recommendations/:id/approve",
    guard,
    wrap(async (req, res) => {
      const { mode, override } = req.body as {
        mode?: "immediate" | "pre-approved";
        override?: boolean;
      };
      const id = req.params.id ?? "";
      // If approving against an unsupportive AI consensus, ask the dashboard to
      // confirm before executing (no accidental overrides).
      const info = engine.approvalOverrideInfo(id);
      if (info.overrideRequired && !override) {
        res.json({ overrideRequired: true, consensus: info });
        return;
      }
      res.json(
        await engine.approve(id, "operator", mode ?? "immediate", !!override),
      );
    }),
  );

  app.post(
    "/api/recommendations/:id/reject",
    guard,
    wrap(async (req, res) => {
      const { reason } = req.body as { reason?: string };
      await engine.reject(req.params.id ?? "", "operator", reason ?? "");
      res.json({ ok: true });
    }),
  );

  // Per-trade conversation (advisory only — cannot place/approve trades).
  app.post(
    "/api/recommendations/:id/discuss",
    guard,
    wrap(async (req, res) => {
      const { question } = req.body as { question?: string };
      res.json(await engine.discussTrade(req.params.id ?? "", String(question ?? "")));
    }),
  );

  // "What if?" — deterministic R:R recompute (+ optional AI interpretation).
  app.post(
    "/api/recommendations/:id/whatif",
    guard,
    wrap(async (req, res) => {
      const { scenario } = req.body as { scenario?: string };
      res.json(await engine.whatIf(req.params.id ?? "", String(scenario ?? "")));
    }),
  );

  // --- kill switch (protected) -----------------------------------------
  app.post(
    "/api/kill-switch",
    guard,
    wrap(async (req, res) => {
      const { engage, reason } = req.body as { engage?: boolean; reason?: string };
      if (engage) {
        await engine.engageKill(reason ?? "manual", "operator");
        res.json(engine.killSwitch.status());
      } else {
        const ok = await engine.disengageKill("operator");
        res.json({ ...engine.killSwitch.status(), disengaged: ok });
      }
    }),
  );

  // --- TopstepX connection (protected) ---------------------------------
  app.get("/api/topstepx/status", (_req, res) => res.json(engine.topstepxStatus()));
  app.post(
    "/api/topstepx/connect",
    guard,
    wrap(async (_req, res) => res.json(await engine.topstepxConnect())),
  );
  app.post("/api/topstepx/disconnect", guard, (_req, res) =>
    res.json(engine.topstepxDisconnect()),
  );
  app.post(
    "/api/topstepx/sync",
    guard,
    wrap(async (_req, res) => res.json(await engine.topstepxSync())),
  );
  app.post(
    "/api/topstepx/execute",
    guard,
    wrap(async (req, res) => {
      const { id } = req.body as { id?: string };
      res.json(await engine.executeRecommendation(id ?? "", "operator"));
    }),
  );
  // Explicit credential/auth diagnostic — never a bare 401. Exempt from the
  // password gate: returns only MASKED credential presence, never secrets.
  app.post(
    "/api/topstepx/auth-test",
    wrap(async (_req, res) => res.json(await engine.topstepxAuthTest())),
  );

  // --- scheduled scanner (manual run + daily summary) ------------------
  app.post(
    "/api/scheduler/run",
    guard,
    wrap(async (_req, res) => res.json(await engine.scheduler.runScanCycle())),
  );
  app.post(
    "/api/scheduler/summary",
    guard,
    wrap(async (_req, res) => {
      const text = engine.dailySummaryText(engine.scheduler.stats().scansToday);
      await engine.notifyText(text, "scheduler.daily_summary");
      res.json({ text });
    }),
  );
  // Runtime enable/disable + interval for the 20-min scanner.
  app.post(
    "/api/scheduler/config",
    guard,
    wrap(async (req, res) => {
      const { enabled, intervalMinutes } = req.body as {
        enabled?: boolean;
        intervalMinutes?: number;
      };
      if (typeof enabled === "boolean") {
        await engine.setScheduler(enabled, intervalMinutes, "operator");
      }
      res.json(engine.scheduler.stats());
    }),
  );

  // --- runtime trading mode toggle (paper/live) ------------------------
  app.post(
    "/api/settings",
    guard,
    wrap(async (req, res) => {
      const { liveTrading } = req.body as { liveTrading?: boolean };
      if (typeof liveTrading === "boolean") {
        await engine.setLiveTrading(liveTrading, "operator");
      }
      res.json({
        liveTrading: engine.isLiveTradingEnabled(),
        liveTradingChecklist: await engine.liveTradingChecklist(false),
      });
    }),
  );

  // Live-trading readiness checklist (read-only).
  app.get(
    "/api/settings/live-checklist",
    wrap(async (_req, res) => res.json(await engine.liveTradingChecklist(false))),
  );

  // AI assistant health (read-only): status, model, last success, last error.
  app.get("/api/ai-health", (_req, res) => res.json(engine.aiHealth()));

  // Full pipeline diagnostics (read-only): scheduler/telegram/AI/topstepx/last scan.
  app.get("/api/diagnostics", (_req, res) => res.json(engine.pipelineDiagnostics()));

  // --- safety validation phase: readiness report + reset ---------------
  // Consolidated readiness report (read-only; re-checks auth live).
  app.get(
    "/api/readiness",
    wrap(async (_req, res) => res.json(await engine.readinessReport(true))),
  );
  // Send the readiness report to Telegram.
  app.post(
    "/api/readiness/send",
    guard,
    wrap(async (_req, res) => res.json(await engine.sendReadinessReport("operator"))),
  );
  // Clear the operator-completed safety validations (forces re-verification).
  app.post(
    "/api/safety/reset",
    guard,
    wrap(async (_req, res) => {
      await engine.resetSafetyValidations("operator");
      res.json(await engine.liveTradingChecklist(false));
    }),
  );

  // --- trading mode (advisor / telegram_approval / full_auto) ----------
  app.post(
    "/api/mode",
    guard,
    wrap(async (req, res) => {
      const { mode } = req.body as { mode?: string };
      if (mode) await engine.setTradingMode(parseTradingMode(mode), "operator");
      res.json({ tradingMode: engine.getTradingMode() });
    }),
  );

  // Manually fire a scheduled report (morning/midday/closing).
  app.post(
    "/api/scheduler/report",
    guard,
    wrap(async (req, res) => {
      const { slot } = req.body as { slot?: "morning" | "midday" | "closing" };
      const text = await engine.sendScheduledReport(
        slot ?? "midday",
        engine.scheduler.stats().scansToday,
      );
      res.json({ text });
    }),
  );

  // --- SMS alerts (protected test) + inbound webhook (number-authorized) -
  app.post(
    "/api/alerts/sms/test",
    guard,
    wrap(async (_req, res) => res.json(await engine.sendTestSms())),
  );

  // --- Telegram (primary alert channel) -------------------------------
  // Test + debug are exempt from the password gate: the test only messages the
  // operator's own configured chat, and debug returns chat ids (no token/secret).
  app.post(
    "/api/alerts/telegram/test",
    wrap(async (_req, res) => res.json(await engine.telegramTest())),
  );
  app.get(
    "/api/telegram/debug",
    wrap(async (_req, res) => res.json(await engine.telegramDebug())),
  );
  app.post(
    "/api/telegram/set-webhook",
    guard,
    wrap(async (_req, res) => {
      const url = `${engine.config.publicBaseUrl.replace(/\/$/, "")}/api/telegram/webhook`;
      res.json(await engine.telegramSetWebhook(url));
    }),
  );
  // Telegram delivers button presses here. Authorized by chat id (not the password).
  app.post(
    "/api/telegram/webhook",
    wrap(async (req, res) => {
      await engine.handleTelegramWebhook(req.body);
      res.json({ ok: true });
    }),
  );

  // Twilio posts here (From, Body). Authorized by phone number, not the password.
  app.post(
    "/api/alerts/sms/inbound",
    wrap(async (req, res) => {
      const body = req.body as { From?: string; Body?: string };
      const reply = await engine.handleInboundSms(body.From ?? "", body.Body ?? "");
      // Reply via TwiML so Twilio texts the confirmation back to the sender.
      res
        .type("text/xml")
        .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
    }),
  );

  // --- tokenized approve/reject links (from notifications) -------------
  const page = (title: string, body: string) =>
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:480px;margin:60px auto;padding:0 20px"><h2>${title}</h2><p>${body}</p></body>`;

  app.get(
    "/api/approve-trade",
    wrap(async (req, res) => {
      try {
        const mode = req.query.mode === "immediate" ? "immediate" : "pre-approved";
        const result = await engine.approveByToken(
          String(req.query.id ?? ""),
          String(req.query.token ?? ""),
          mode,
        );
        res.status(200).send(
          page(
            "✅ Approved",
            result.armed
              ? "Trade pre-approved. It will execute when the entry is reached and all checks still pass, before it expires."
              : `Trade approved and submitted (${result.result?.paper ? "paper" : "LIVE"}).`,
          ),
        );
      } catch (err) {
        res.status(400).send(page("⚠️ Could not approve", err instanceof Error ? err.message : "error"));
      }
    }),
  );

  app.get(
    "/api/reject-trade",
    wrap(async (req, res) => {
      try {
        await engine.rejectByToken(String(req.query.id ?? ""), String(req.query.token ?? ""));
        res.status(200).send(page("🛑 Rejected", "The setup was rejected."));
      } catch (err) {
        res.status(400).send(page("⚠️ Could not reject", err instanceof Error ? err.message : "error"));
      }
    }),
  );

  // --- error middleware (last) — always responds, never hangs ----------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("API error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  });

  // --- pre-approved queue maintenance loop -----------------------------
  const tick = () => engine.maintain().catch((e) => console.error("maintain error:", e));
  setInterval(tick, 20_000);

  const port = engine.config.dashboard.port;
  app.listen(port, () => {
    console.log(`Avrrio dashboard on http://localhost:${port}`);
    for (const w of engine.warnings()) console.warn(`⚠️  ${w}`);
    engine.scheduler.start(); // no-op unless SCHEDULED_SCANNER_ENABLED=true
    // Best-effort: register the Telegram webhook so button presses are delivered.
    if (engine.telegram.enabled && engine.config.publicBaseUrl.startsWith("https")) {
      const url = `${engine.config.publicBaseUrl.replace(/\/$/, "")}/api/telegram/webhook`;
      engine
        .telegramSetWebhook(url)
        .then((r) => console.log(`Telegram webhook: ${r.ok ? "set " + url : r.info}`))
        .catch(() => {});
    }
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

start().catch((err) => {
  console.error("Failed to start dashboard:", err);
  process.exit(1);
});
