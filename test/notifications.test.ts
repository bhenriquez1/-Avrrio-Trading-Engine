import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import {
  buildPayload,
  renderText,
  NotificationManager,
  type NotificationChannel,
} from "../src/notifications/notifier.js";
import type { Recommendation } from "../src/execution/recommendations.js";

function fakeRec(): Recommendation {
  return {
    id: "rec-1",
    ref: "T-1042",
    createdAt: new Date().toISOString(),
    setupName: null,
    symbol: "NQ",
    side: "long",
    size: 1,
    entry: 22150,
    stopLoss: 22100,
    target: 22300,
    riskAmount: 200,
    rewardRiskRatio: 3,
    riskApproved: true,
    violations: [],
    avrrioScore: 91,
    grade: null,
    consensus: {
      recommendation: "long",
      confidence: 0.84,
      agreement: 2,
      available: 2,
      opinions: [],
    },
    news: { blocked: false, reason: "clear" },
    autoEligible: false,
    status: "pending",
    approvalToken: "secret-token",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    approvalMode: null,
  };
}

test("buildPayload creates tokenized approve/reject links", () => {
  const config = loadConfig();
  config.publicBaseUrl = "https://avrrio.example.com";
  const p = buildPayload(config, fakeRec());
  assert.equal(
    p.approveUrl,
    "https://avrrio.example.com/api/approve-trade?id=rec-1&token=secret-token",
  );
  assert.equal(
    p.rejectUrl,
    "https://avrrio.example.com/api/reject-trade?id=rec-1&token=secret-token",
  );
  assert.equal(p.symbol, "NQ");
  assert.equal(p.entry, 22150);
});

test("renderText includes the key trade details", () => {
  const config = loadConfig();
  const text = renderText(buildPayload(config, fakeRec()));
  assert.match(text, /NQ LONG/);
  assert.match(text, /Entry 22150/);
  assert.match(text, /Approve:/);
  assert.match(text, /Reject:/);
});

test("manager sends nothing when notifications are disabled", async () => {
  const config = loadConfig();
  config.notifications.enabled = false;
  const stub: NotificationChannel = {
    name: "stub",
    enabled: true,
    async send() {
      return { channel: "stub", ok: true, info: "sent" };
    },
  };
  const mgr = new NotificationManager(config, [stub]);
  assert.deepEqual(await mgr.notify(fakeRec()), []);
});

test("manager fans out to enabled channels when on", async () => {
  const config = loadConfig();
  config.notifications.enabled = true;
  let sent = 0;
  const stub: NotificationChannel = {
    name: "stub",
    enabled: true,
    async send() {
      sent++;
      return { channel: "stub", ok: true, info: "sent" };
    },
  };
  const off: NotificationChannel = {
    name: "off",
    enabled: false,
    async send() {
      sent++;
      return { channel: "off", ok: true, info: "sent" };
    },
  };
  const mgr = new NotificationManager(config, [stub, off]);
  const results = await mgr.notify(fakeRec());
  assert.equal(sent, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.channel, "stub");
});
