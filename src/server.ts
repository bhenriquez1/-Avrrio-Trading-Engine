import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AvrrioEngine, type ProposeInput } from "./engine.js";
import { SYMBOLS, type AssetClass } from "./symbols/registry.js";

/**
 * Dashboard server.
 *
 * Auth: a password gate (DASHBOARD_PASSWORD) protects every mutating route —
 * propose, approve, reject, kill switch. Reads of status/recommendations/audit
 * also require the token when a password is configured.
 *
 * There is no route that places an order directly. The only execution path is
 * approving a stored recommendation, which runs through the OrderExecutor and
 * all safety gates.
 */
const here = dirname(fileURLToPath(import.meta.url));

async function start() {
  const engine = new AvrrioEngine();
  await engine.init();

  const app = express();
  app.use(express.json());
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

  // --- status & data (protected) ---------------------------------------
  app.get("/api/status", guard, async (_req, res) => {
    const account = await engine.getAccount();
    res.json({
      account,
      offline: engine.client.isOffline,
      liveTrading: engine.config.execution.liveTradingEnabled,
      semiAutonomous: engine.config.execution.semiAutonomousEnabled,
      killSwitch: engine.killSwitch.status(),
      providers: engine.consensus.availableProviders(),
      newsEnabled: engine.news.enabled,
      notifications: {
        enabled: engine.notifications.enabled,
        channels: engine.notifications.activeChannels(),
      },
      approvalExpiryMinutes: engine.config.queue.approvalExpiryMinutes,
      warnings: engine.warnings(),
      journalStats: engine.journal.stats(),
      safety: engine.config.safety,
    });
  });

  app.get("/api/recommendations", guard, (_req, res) => {
    res.json(engine.recommendations.list());
  });

  app.get("/api/audit", guard, async (_req, res) => {
    res.json(await engine.audit.recent(100));
  });

  app.get("/api/snapshot/:symbol", guard, async (req, res) => {
    res.json(await engine.snapshot(req.params.symbol ?? ""));
  });

  app.get("/api/symbols", guard, (_req, res) => {
    res.json(SYMBOLS);
  });

  app.get("/api/scan", guard, async (req, res) => {
    const classesParam = String(req.query.classes ?? "");
    const classes = classesParam
      ? (classesParam.split(",").filter(Boolean) as AssetClass[])
      : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await engine.scan({ classes, limit }));
  });

  // --- workflow (protected) --------------------------------------------
  app.post("/api/propose", guard, async (req, res) => {
    try {
      const rec = await engine.propose(req.body as ProposeInput);
      res.json(rec);
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "propose failed" });
    }
  });

  app.post("/api/recommendations/:id/approve", guard, async (req, res) => {
    try {
      const { mode } = req.body as { mode?: "immediate" | "pre-approved" };
      const result = await engine.approve(
        req.params.id ?? "",
        "operator",
        mode ?? "immediate",
      );
      res.json(result);
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "approve failed" });
    }
  });

  app.post("/api/recommendations/:id/reject", guard, async (req, res) => {
    try {
      const { reason } = req.body as { reason?: string };
      await engine.reject(req.params.id ?? "", "operator", reason ?? "");
      res.json({ ok: true });
    } catch (err) {
      res
        .status(400)
        .json({ error: err instanceof Error ? err.message : "reject failed" });
    }
  });

  // --- kill switch (protected) -----------------------------------------
  app.post("/api/kill-switch", guard, async (req, res) => {
    const { engage, reason } = req.body as { engage?: boolean; reason?: string };
    if (engage) {
      await engine.engageKill(reason ?? "manual", "operator");
      res.json(engine.killSwitch.status());
    } else {
      const ok = await engine.disengageKill("operator");
      res.json({ ...engine.killSwitch.status(), disengaged: ok });
    }
  });

  // --- tokenized approve/reject links (from phone notifications) -------
  // Not behind the password guard — authenticated by the per-recommendation
  // approval token in the link. Approving via link uses pre-approved mode so the
  // trade waits for its entry and conditions rather than firing blind.
  const page = (title: string, body: string) =>
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;max-width:480px;margin:60px auto;padding:0 20px"><h2>${title}</h2><p>${body}</p></body>`;

  app.get("/api/approve-trade", async (req, res) => {
    try {
      const id = String(req.query.id ?? "");
      const token = String(req.query.token ?? "");
      const mode =
        req.query.mode === "immediate" ? "immediate" : "pre-approved";
      const result = await engine.approveByToken(id, token, mode);
      res
        .status(200)
        .send(
          page(
            "✅ Approved",
            result.armed
              ? "Trade pre-approved. It will execute when the entry is reached and all risk/news checks still pass, before it expires."
              : `Trade approved and submitted (${result.result?.paper ? "paper" : "LIVE"}).`,
          ),
        );
    } catch (err) {
      res
        .status(400)
        .send(page("⚠️ Could not approve", err instanceof Error ? err.message : "error"));
    }
  });

  app.get("/api/reject-trade", async (req, res) => {
    try {
      await engine.rejectByToken(
        String(req.query.id ?? ""),
        String(req.query.token ?? ""),
      );
      res.status(200).send(page("🛑 Rejected", "The setup was rejected."));
    } catch (err) {
      res
        .status(400)
        .send(page("⚠️ Could not reject", err instanceof Error ? err.message : "error"));
    }
  });

  // --- pre-approved queue maintenance loop -----------------------------
  // Expires stale recommendations and triggers armed (pre-approved) trades.
  const tick = () =>
    engine.maintain().catch((e) => console.error("maintain error:", e));
  setInterval(tick, 20_000);

  const port = engine.config.dashboard.port;
  app.listen(port, () => {
    console.log(`Avrrio dashboard on http://localhost:${port}`);
    for (const w of engine.warnings()) console.warn(`⚠️  ${w}`);
  });
}

start().catch((err) => {
  console.error("Failed to start dashboard:", err);
  process.exit(1);
});
