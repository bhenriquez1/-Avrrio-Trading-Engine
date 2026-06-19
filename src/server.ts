import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AvrrioEngine, type ProposeInput } from "./engine.js";

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
      const result = await engine.approve(req.params.id ?? "", "operator");
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
