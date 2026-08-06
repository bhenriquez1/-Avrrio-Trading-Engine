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
    res.json({
      ok: true,
      service: "avrrio-trading-engine",
      time: new Date().toISOString(),
    });
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
        accountError =
          err instanceof Error ? err.message : "account unavailable";
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
        execution: {
          liveTradingEnabled: engine.isLiveTradingEnabled(),
          tradingMode: engine.getTradingMode(),
        },
        coinbase: {
          tradingEnabled: engine.coinbase.tradingEnabled,
          offline: engine.coinbase.isOffline,
        },
      });
    }),
  );

  app.get("/api/recommendations", guard, (_req, res) => {
    res.json(engine.recommendations.list());
  });

  // Dashboard shorthand aliases for the approval queue
  app.get("/api/queue", guard, (_req, res) => {
    res.json({
      queue: engine.recommendations
        .list()
        .filter((r) => r.status === "pending"),
    });
  });
  app.post(
    "/api/queue/approve",
    guard,
    wrap(async (req, res) => {
      const { id } = req.body as { id?: string };
      if (!id) {
        res.status(400).json({ error: "id required" });
        return;
      }
      res.json(await engine.approve(id, "operator", "immediate", false));
    }),
  );
  app.post(
    "/api/queue/reject",
    guard,
    wrap(async (req, res) => {
      const { id } = req.body as { id?: string };
      if (!id) {
        res.status(400).json({ error: "id required" });
        return;
      }
      res.json(await engine.reject(id, "operator"));
    }),
  );

  // Live Trade Management — open positions under continuous re-analysis.
  app.get("/api/positions/open", guard, (_req, res) => {
    res.json(engine.recommendations.openPositions());
  });

  // Dashboard alias: /api/positions returns { positions: [...] }
  app.get("/api/positions", guard, (_req, res) => {
    res.json({ positions: engine.recommendations.openPositions() });
  });

  app.post(
    "/api/positions/:id/close",
    guard,
    wrap(async (req, res) =>
      res.json(await engine.closePosition(req.params.id ?? "", "operator")),
    ),
  );

  // Dashboard alias: close by symbol
  app.post(
    "/api/orders/close",
    guard,
    wrap(async (req, res) => {
      const { symbol } = req.body as { symbol?: string };
      if (!symbol) {
        res.status(400).json({ error: "symbol required" });
        return;
      }
      const positions = engine.recommendations.openPositions();
      const pos = positions.find((p) => p.symbol === symbol);
      if (!pos) {
        res.status(404).json({ error: "no open position for " + symbol });
        return;
      }
      res.json(await engine.closePosition(pos.id, "operator"));
    }),
  );

  app.get(
    "/api/audit",
    guard,
    wrap(async (_req, res) => res.json(await engine.audit.recent(100))),
  );

  app.get(
    "/api/snapshot/:symbol",
    guard,
    wrap(async (req, res) =>
      res.json(await engine.snapshot(req.params.symbol ?? "")),
    ),
  );

  // Explain WHY a specific symbol does/doesn't qualify right now (any symbol,
  // not just the scan's top near-misses). Read-only — never proposes a trade.
  app.get(
    "/api/why/:symbol",
    guard,
    wrap(async (req, res) =>
      res.json(await engine.explainSymbol(req.params.symbol ?? "")),
    ),
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
      res.json({ results });
    }),
  );

  // Numbered ranking of EVERY symbol in the universe, best to worst. Read-only
  // — never proposes a trade.
  app.get(
    "/api/rank",
    guard,
    wrap(async (_req, res) => res.json(await engine.rankMarkets())),
  );

  // --- market data bars (used by the chart widget) ----------------------
  app.get(
    "/api/market/bars/:symbol",
    guard,
    wrap(async (req, res) => {
      const sym = req.params.symbol ?? "";
      const snap = await engine.snapshot(sym);
      res.json({ bars: snap.bars });
    }),
  );

  // --- Coinbase -----------------------------------------------------------
  app.get(
    "/api/coinbase/status",
    guard,
    wrap(async (_req, res) => res.json(await engine.coinbaseStatus())),
  );

  app.get(
    "/api/coinbase/auth-test",
    guard,
    wrap(async (_req, res) => res.json(await engine.coinbaseAuthTest())),
  );

  app.get(
    "/api/coinbase/bars/:productId",
    guard,
    wrap(async (req, res) => {
      const productId = decodeURIComponent(req.params.productId ?? "");
      const bars = await engine.coinbase.getBars(productId, 60);
      res.json({ bars });
    }),
  );

  app.get(
    "/api/coinbase/quote/:productId",
    guard,
    wrap(async (req, res) => {
      const productId = decodeURIComponent(req.params.productId ?? "");
      const quote = await engine.coinbase.getQuote(productId);
      res.json(quote);
    }),
  );

  // --- workflow (protected) --------------------------------------------
  app.post(
    "/api/propose",
    guard,
    wrap(async (req, res) =>
      res.json(await engine.propose(req.body as ProposeInput)),
    ),
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
      res.json(
        await engine.discussTrade(req.params.id ?? "", String(question ?? "")),
      );
    }),
  );

  // General conversation about any symbol or "my position(s)" — same path as
  // /ask in Telegram. Advisory only — never places or approves a trade.
  app.post(
    "/api/ask",
    guard,
    wrap(async (req, res) => {
      const question = String(
        (req.body as { question?: string }).question ?? "",
      );
      const answer = question
        ? await engine.claude.ask(
            question,
            await engine.buildConversationContext(question),
          )
        : "Add a question.";
      res.json({ question, answer });
    }),
  );

  // "What if?" — deterministic R:R recompute (+ optional AI interpretation).
  app.post(
    "/api/recommendations/:id/whatif",
    guard,
    wrap(async (req, res) => {
      const { scenario } = req.body as { scenario?: string };
      res.json(
        await engine.whatIf(req.params.id ?? "", String(scenario ?? "")),
      );
    }),
  );

  // Debate Mode — Bull/Bear/Verdict for a recommendation (id/ref) or symbol.
  app.post(
    "/api/recommendations/:id/debate",
    guard,
    wrap(async (req, res) =>
      res.json(await engine.debate(req.params.id ?? "")),
    ),
  );
  app.post(
    "/api/debate/:symbol",
    guard,
    wrap(async (req, res) =>
      res.json(await engine.debate(req.params.symbol ?? "")),
    ),
  );

  // Trade Coach — post-trade review of a recommendation (id/ref).
  app.post(
    "/api/recommendations/:id/coach",
    guard,
    wrap(async (req, res) =>
      res.json(await engine.coachTrade(req.params.id ?? "")),
    ),
  );

  // Avrrio Memory — habit stats and per-trade "resembles a pattern" check.
  app.get("/api/memory", guard, (_req, res) => {
    res.json({
      overall: engine.memory.overall(),
      bySetup: engine.memory.bySetup(),
      bySide: engine.memory.bySide(),
      byHour: engine.memory.byHour(),
      insights: engine.memory.insights(),
      summary: engine.memorySummaryText(),
    });
  });
  app.post("/api/recommendations/:id/memory", guard, (req, res) =>
    res.json(engine.assessMemory(req.params.id ?? "")),
  );

  // --- kill switch (protected) -----------------------------------------
  app.post(
    "/api/kill-switch",
    guard,
    wrap(async (req, res) => {
      const { engage, reason } = req.body as {
        engage?: boolean;
        reason?: string;
      };
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
  app.get("/api/topstepx/status", (_req, res) =>
    res.json(engine.topstepxStatus()),
  );
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
    wrap(async (_req, res) =>
      res.json(await engine.liveTradingChecklist(false)),
    ),
  );

  // AI assistant health (read-only): Claude + OpenAI status. Never exposes keys.
  app.get("/api/ai-health", (_req, res) => {
    const claude = engine.aiHealth();
    const openaiConfigured = engine.config.ai.openaiApiKey.length > 0;
    const tradegptConfigured = engine.config.ai.tradegptApiKey.length > 0;
    res.json({
      anthropic: {
        configured: claude.enabled,
        enabled: claude.enabled,
        healthy: claude.status === "online",
        model: claude.model,
        lastSuccessAt: claude.lastSuccessAt,
        lastError: claude.lastError,
      },
      openai: {
        configured: openaiConfigured,
        enabled: openaiConfigured,
        healthy: openaiConfigured,
        model: engine.config.ai.openaiModel,
      },
      tradegpt: {
        configured: tradegptConfigured,
        enabled: tradegptConfigured,
        model: engine.config.ai.tradegptModel,
      },
      providers: engine.consensus.availableProviders(),
    });
  });

  // AI chat assistant (guarded). Advisory only — never places orders.
  // The frontend sends POST /api/chat with { message } and expects { reply }.
  app.post(
    "/api/chat",
    guard,
    wrap(async (req, res) => {
      const { message } = req.body as { message?: string };
      if (!message || typeof message !== "string" || !message.trim()) {
        res.status(400).json({ error: "message is required" });
        return;
      }
      const context = await engine.buildConversationContext(message);
      const reply = await engine.claude.ask(message.trim(), context);
      res.json({ reply });
    }),
  );

  // Full pipeline diagnostics (read-only): scheduler/telegram/AI/topstepx/last scan.
  app.get("/api/diagnostics", (_req, res) =>
    res.json(engine.pipelineDiagnostics()),
  );

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
    wrap(async (_req, res) =>
      res.json(await engine.sendReadinessReport("operator")),
    ),
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
      const reply = await engine.handleInboundSms(
        body.From ?? "",
        body.Body ?? "",
      );
      // Reply via TwiML so Twilio texts the confirmation back to the sender.
      res
        .type("text/xml")
        .send(
          `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`,
        );
    }),
  );

  // --- tokenized approve/reject links (from notifications) -------------
  const page = (title: string, body: string) =>
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:480px;margin:60px auto;padding:0 20px"><h2>${title}</h2><p>${body}</p></body>`;

  app.get(
    "/api/approve-trade",
    wrap(async (req, res) => {
      try {
        const mode =
          req.query.mode === "immediate" ? "immediate" : "pre-approved";
        const result = await engine.approveByToken(
          String(req.query.id ?? ""),
          String(req.query.token ?? ""),
          mode,
        );
        res
          .status(200)
          .send(
            page(
              "✅ Approved",
              result.armed
                ? "Trade pre-approved. It will execute when the entry is reached and all checks still pass, before it expires."
                : `Trade approved and submitted (${result.result?.paper ? "paper" : "LIVE"}).`,
            ),
          );
      } catch (err) {
        res
          .status(400)
          .send(
            page(
              "⚠️ Could not approve",
              err instanceof Error ? err.message : "error",
            ),
          );
      }
    }),
  );

  app.get(
    "/api/reject-trade",
    wrap(async (req, res) => {
      try {
        await engine.rejectByToken(
          String(req.query.id ?? ""),
          String(req.query.token ?? ""),
        );
        res.status(200).send(page("🛑 Rejected", "The setup was rejected."));
      } catch (err) {
        res
          .status(400)
          .send(
            page(
              "⚠️ Could not reject",
              err instanceof Error ? err.message : "error",
            ),
          );
      }
    }),
  );

  // --- error middleware (last) — always responds, never hangs ----------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("API error:", err);
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : "internal error" });
  });

  // --- pre-approved queue maintenance loop -----------------------------
  const tick = () =>
    engine.maintain().catch((e) => console.error("maintain error:", e));
  setInterval(tick, 20_000);

  const port = engine.config.dashboard.port;
  app.listen(port, () => {
    console.log(`Avrrio dashboard on http://localhost:${port}`);
    for (const w of engine.warnings()) console.warn(`⚠️  ${w}`);
    engine.scheduler.start(); // no-op unless SCHEDULED_SCANNER_ENABLED=true
    // Best-effort: register the Telegram webhook so button presses are delivered.
    if (
      engine.telegram.enabled &&
      engine.config.publicBaseUrl.startsWith("https")
    ) {
      const url = `${engine.config.publicBaseUrl.replace(/\/$/, "")}/api/telegram/webhook`;
      engine
        .telegramSetWebhook(url)
        .then((r) =>
          console.log(`Telegram webhook: ${r.ok ? "set " + url : r.info}`),
        )
        .catch(() => {});
    }
  });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

start().catch((err) => {
  console.error("Failed to start dashboard:", err);
  process.exit(1);
});
