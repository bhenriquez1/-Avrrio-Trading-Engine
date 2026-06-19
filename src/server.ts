import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AvrrioEngine } from "./engine.js";
import type { TradeIdea } from "./types.js";

/**
 * Dashboard server. Exposes read-only JSON endpoints + a static dashboard
 * showing account status, risk limits, trade ideas, and rule violations.
 *
 * There is no order-placement endpoint. The only mutating route journals a
 * trade *idea* (paper) after running it through the risk manager.
 */
const here = dirname(fileURLToPath(import.meta.url));

async function start() {
  const engine = new AvrrioEngine();
  await engine.init();

  const app = express();
  app.use(express.json());
  app.use(express.static(join(here, "dashboard", "public")));

  app.get("/api/status", async (_req, res) => {
    const account = await engine.getAccount();
    res.json({
      account,
      offline: engine.client.isOffline,
      claudeEnabled: engine.claude.enabled,
      warnings: engine.warnings(),
      journalStats: engine.journal.stats(),
    });
  });

  app.get("/api/snapshot/:symbol", async (req, res) => {
    res.json(await engine.snapshot(req.params.symbol));
  });

  app.get("/api/journal", (_req, res) => {
    res.json(engine.journal.list());
  });

  app.post("/api/evaluate", async (req, res) => {
    const idea = req.body as TradeIdea;
    try {
      const result = await engine.evaluate(idea);
      res.json(result);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "evaluation failed",
      });
    }
  });

  const port = engine.config.dashboardPort;
  app.listen(port, () => {
    console.log(`Avrrio dashboard on http://localhost:${port}`);
    for (const w of engine.warnings()) console.warn(`⚠️  ${w}`);
  });
}

start().catch((err) => {
  console.error("Failed to start dashboard:", err);
  process.exit(1);
});
