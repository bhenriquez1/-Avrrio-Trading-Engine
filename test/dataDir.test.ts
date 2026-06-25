import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, configWarnings } from "../src/config.js";
import { AvrrioEngine } from "../src/engine.js";

test("dataDir defaults to 'data' and reads DATA_DIR (trailing slash trimmed)", () => {
  delete process.env.DATA_DIR;
  delete process.env.AVRRIO_DATA_DIR;
  assert.equal(loadConfig().dataDir, "data");

  process.env.DATA_DIR = "/var/data/";
  assert.equal(loadConfig().dataDir, "/var/data");
  delete process.env.DATA_DIR;

  process.env.AVRRIO_DATA_DIR = "/mnt/disk";
  assert.equal(loadConfig().dataDir, "/mnt/disk");
  delete process.env.AVRRIO_DATA_DIR;
});

test("configWarnings flags the default (ephemeral) data dir", () => {
  const config = loadConfig();
  config.dataDir = "data";
  config.dashboard.password = "x"; // isolate the dataDir warning
  assert.ok(configWarnings(config).some((w) => /DATA_DIR is unset/.test(w)));

  config.dataDir = "/var/data";
  assert.ok(!configWarnings(config).some((w) => /DATA_DIR is unset/.test(w)));
});

test("engine writes all state under config.dataDir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avrrio-datadir-"));
  const config = loadConfig();
  config.dataDir = dir;
  const engine = new AvrrioEngine(config);
  await engine.init();
  // Recording an outcome persists memory under the configured dir, not ./data.
  await engine.recordTradeOutcome({ symbol: "NQ", side: "long", pnl: 100, setup: "pullback" });
  const files = await readdir(dir);
  assert.ok(files.includes("memory.json"), `expected memory.json under dataDir, got ${files.join(", ")}`);
});
