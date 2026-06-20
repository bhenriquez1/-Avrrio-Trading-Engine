# Avrrio Trading Engine

A **risk-first trading assistant** for TopstepX / ProjectX futures accounts. It
reads account rules and market data, asks multiple AI models for a consensus
opinion, runs every trade through a hard risk manager, and **requires your
approval before any order is sent**. Optionally, it can operate semi-autonomously
— but only when every safety gate passes.

> **Do not build a gambling bot. This is a risk-first assistant where capital
> protection is the highest priority.** AI suggests → risk engine verifies →
> you approve → system executes.

## Safety model

- **Default safe.** `LIVE_TRADING_ENABLED=false` and `SEMI_AUTONOMOUS_ENABLED=false`
  by default. With live trading off, every approval is a **paper** fill.
- **Approval required.** The only execution path is approving a stored
  recommendation; it runs through the `OrderExecutor` and re-checks every gate at
  execution time.
- **Emergency kill switch.** `KILL_SWITCH` env (immovable) + a dashboard
  "Emergency Stop" button. When engaged, all trading is blocked.
- **Password gate.** `DASHBOARD_PASSWORD` protects the dashboard and every
  approve/reject/kill action.
- **Full audit log.** Every recommendation, risk check, approval, rejection,
  kill-switch toggle, and order result is written to `data/audit.jsonl`.

## Phases

- **Phase 1 — analyst + risk manager.** Read-only data, risk checks, journaling.
- **Phase 2 — live orders with manual approval.** Approval screen with symbol,
  direction, entry, stop, target, size, max risk, Topstep rule check, AI
  rationale, and confidence. Order placed only after **Approve Trade**.
- **Phase 3 — semi-autonomous.** Predefined setups only, AI consensus (2-of-3),
  news guard, and the full safety stack. Auto-executes **only** when every gate
  passes; otherwise blocks and logs the reason.

See [docs/strategy-notes.md](docs/strategy-notes.md) for the staged rollout.

## The ten safety features

1. **Max daily loss** — `DAILY_MAX_LOSS`; blocks new trades when the budget is exhausted.
2. **Max position size** — `MAX_POSITION_SIZE`; rejects oversize orders.
3. **Predefined setups only** — `src/setups/`; the AI cannot invent trades.
4. **Risk manager** — daily-loss, size, stop-required, news, Topstep-rule, duplicate, hours, per-trade-risk checks.
5. **Emergency kill switch** — `KILL_SWITCH` + dashboard button; logged with actor + time.
6. **News reader** — blocks trades near high-impact news (`NEWS_API_URL`), with manual override.
7. **AI consensus engine** — Claude + OpenAI + TradeGPT; trade only if ≥2 agree.
8. **Execution rules** — semi-autonomous only when setup + risk + news + 2/3 + confidence all pass.
9. **Audit log** — every decision recorded.
10. **Default safe mode** — live + semi-autonomous off unless explicitly enabled.

## Scheduled opportunity scanner

For a 9–5 schedule: every `SCAN_INTERVAL_MINUTES` (default 20) Avrrio scans
futures, stocks, and crypto, scores them, and **only alerts on the best, tradable
futures setups** — so your phone gets the top 1–3 ideas, not noise:

```
Avrrio Score ≥ AVRRIO_ALERT_SCORE (default 85)   AND   reward/risk ≥ AVRRIO_MIN_RR (default 2)
```

- **Sends nothing when nothing qualifies.** Capped at `AVRRIO_MAX_ALERTS` (default 3) per cycle; duplicate open symbols are skipped.
- Each qualifying setup becomes a pending recommendation with synthesized entry/stop/target (~3:1 R/R) and fires the 🚨 signal SMS (`YES/NO/STOPALL`). Approvals run the full safety + TopstepX gates; with `LIVE_TRADING_ENABLED=false` they fill in paper.
- **Daily summary:** set `DAILY_SUMMARY_HOUR` (0–23, local; -1 disables) to text an end-of-day report (scans, signals, approved, rejected, win rate, P&L).
- Off by default (`SCHEDULED_SCANNER_ENABLED=false`), but you can **enable/disable
  it and set the interval at runtime** from the dashboard (persisted) — no redeploy.
  Status shows scans today, last scan time, and last alert time. Dashboard has a
  **Run scan cycle** button; CLI: `scan-cycle`, `summary`. API: `POST /api/scheduler/run`,
  `POST /api/scheduler/config { enabled, intervalMinutes }`, `POST /api/scheduler/summary`.

## Telegram alerts (primary channel)

Telegram is the **primary** alert channel — full trade detail with one-tap
**APPROVE / REJECT / STOP ALL** buttons (no typing). SMS is the backup.

Setup:
1. Create a bot with **@BotFather** → `TELEGRAM_BOT_TOKEN`, set `TELEGRAM_ENABLED=true`.
2. Get your chat id from **@userinfobot**, or click **Telegram chat ID** on the
   dashboard (`GET /api/telegram/debug` → calls `getUpdates` and returns the
   `chat_id`s found) after messaging your bot once → `TELEGRAM_CHAT_ID`.
3. Button presses arrive via a webhook that **auto-registers on startup** when
   `PUBLIC_BASE_URL` is https (or `POST /api/telegram/set-webhook`).

Each alert sends Trade ID, asset, symbol, long/short, entry, stop, target, size,
risk/reward, confidence, and Avrrio Score. Pressing **APPROVE** runs the full
safety stack (valid + not expired, kill switch clear, daily-loss budget, TopstepX
gate) and executes a **paper** trade while `LIVE_TRADING_ENABLED=false`. Only the
configured chat id is authorized; every action is audited.

- `POST /api/alerts/telegram/test`, `GET /api/telegram/debug`,
  `POST /api/telegram/set-webhook`, `POST /api/telegram/webhook` (Telegram → us).

## SMS alerts & approve-by-reply (backup)

Built so you can act on a setup from your phone without opening the dashboard
(`src/sms/`). When a recommendation is generated, Avrrio texts the full signal:

```
🚨 Avrrio Trade AI Signal
Trade ID: T-1042
Symbol: NQ   Side: LONG
Entry: 20000  Stop: 19960  Target: 20080
Risk: 40 pts ($800)  R:R = 1:2
AI Confidence: 84%   Avrrio Score: 91/100
Reply YES T-1042 to approve
Reply NO T-1042 to reject
Reply STOPALL for Emergency Stop
```

**Inbound replies** hit `POST /api/alerts/sms/inbound` (Twilio webhook). Commands:
`YES/APPROVE {ref}`, `NO/REJECT {ref}`, `STOPALL`, `STATUS`, `PENDING`. Only the
authorized `ALERT_PHONE_NUMBER` is accepted — other numbers are rejected. Every
command is audited and gets a confirmation reply.

**Approval safety gates (SMS or dashboard):** AI only proposes; approval is
required; expired signals can't be approved; approval is blocked if the price has
moved too far from entry, the daily-loss limit is hit, the kill switch is active,
or — in live mode — TopstepX isn't connected.

- `POST /api/alerts/sms/test` → sends "Avrrio Trade AI test alert successful."
- Env: `SMS_ENABLED`, `SMS_PROVIDER`, `TWILIO_*`, `ALERT_PHONE_NUMBER`, `AVRRIO_ALERT_SCORE`.

Telegram alerts/commands are a planned follow-up (Phase 2) — SMS first.

## TopstepX connection & auth troubleshooting

**Connect your PRACTICE account first** (`TOPSTEP_MODE=practice`), keep
`LIVE_TRADING_ENABLED=false`, verify SMS approval in paper mode, then flip to live.

**Auth method:** TopstepX uses the ProjectX Gateway API — `POST /api/Auth/loginKey`
with **username + API key** → a session token (Bearer). Password / account name
are accepted for account selection but loginKey only needs username + API key.

**If you see HTTP 401 / "did not return a token":** it's almost always env-var
naming or wrong credentials. Diagnose without guessing:

- **Dashboard → "Auth test"** (or `POST /api/topstepx/auth-test`) reports the exact
  **endpoint called**, HTTP **status**, stage — `missing_credentials` (and which),
  `invalid_credentials`, `token_not_returned` (with the **sanitized ProjectX
  response / errorMessage** so you can see *why* no token), or `connected` — plus a
  **masked** presence map (never logs secrets). Connect never returns a bare 401.
- **`token_not_returned`** means ProjectX accepted the request (HTTP 200) but sent
  no token — almost always an invalid/disabled API key or wrong field. The
  sanitized response body in the auth-test result tells you what it said.
- **Scans don't crash on a broken connection** — if market reads fail, the scanner
  falls back to **simulated** data and the dashboard warns (`usingFallbackData`).
  Account sync and execution still require a valid token.
- **Env var names are normalized** (case-insensitive, with fallbacks), so
  `TOPSTEP_Practice_Username` etc. are picked up — but use the canonical names:

  ```env
  TOPSTEP_MODE=practice
  TOPSTEP_USERNAME=your_practice_username
  TOPSTEP_PASSWORD=your_practice_password
  TOPSTEP_ACCOUNT_NAME=your_practice_account_name
  TOPSTEP_API_KEY=your_api_key
  TOPSTEP_API_BASE_URL=https://api.topstepx.com
  LIVE_TRADING_ENABLED=false
  ```

**Execution gating:** in **live** mode a trade executes only when TopstepX is
`connected` + `authenticated` + `active` (otherwise approval is accepted but
execution is blocked, with an SMS explaining why). **Paper** mode allows simulated
fills so the workflow is testable.

**Paper/Live toggle:** the dashboard header has a **Trading: paper/LIVE** button
(persisted, defaults paper) so you can switch without a redeploy — confirmation
required to go live, and live still passes every safety gate.

- `GET /api/topstepx/status`, `POST /api/topstepx/{connect,disconnect,sync,execute,auth-test}`
- `POST /api/settings { "liveTrading": true|false }`
- Dashboard TopstepX card: connection state + message, account, buying power, daily
  P&L, max daily loss, open positions, last sync, Connect/Disconnect/Sync/Auth-test.

## Stability

- `GET /api/health` (and `/healthz`) does no external I/O — use it for the Render
  health check (`render.yaml`). This is what the platform pings instead of an API
  route that depends on the broker.
- Every async route is wrapped so a failure returns JSON, never a hung request
  (the prior 502 cause). `/api/status` is resilient: a broker/network error
  returns `accountError` instead of failing the whole dashboard.
- The frontend parses responses safely — a non-JSON error page shows a banner
  instead of crashing with `Unexpected token '<'`.

## Execution modes & the pre-approved queue

Designed for someone who can't watch the screen 9–5:

- **Mode 1 — Manual:** AI recommends → you **Approve now** → executes immediately.
- **Mode 2 — Pre-approved (best for a day job):** AI recommends → you **Pre-approve**
  (from the dashboard or a phone link) → the trade is **armed** and waits. A
  maintenance loop executes it only when **the entry is reached AND** risk limits
  pass, no high-impact news, and the kill switch is clear — before it expires.
- **Mode 3 — Semi-autonomous:** auto-executes when every gate passes
  (`SEMI_AUTONOMOUS_ENABLED=true`).

Every recommendation has an **expiration** (`NOTIFICATION_EXPIRY_MINUTES`, default
5): if not approved in time it auto-cancels, preventing stale trades.

## Phone / alert notifications

When a setup is found, Avrrio can alert you so you can approve, reject, or let it
expire from your phone (`src/notifications/`):

- **Telegram** (recommended first — fast, free): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- **Email** (on by default; sends when configured): SendGrid `SENDGRID_API_KEY`, `NOTIFICATION_EMAIL_TO`.
- **SMS** (add later): Twilio `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` / `BRIAN_PHONE_NUMBER`.

Alerts include symbol, direction, entry, stop, target, risk, confidence, news
status, expiration, and **tokenized approve/reject links** that work without a
dashboard login:

- `GET /api/approve-trade?id=…&token=…` (pre-approved by default)
- `GET /api/reject-trade?id=…&token=…`

Set `PUBLIC_BASE_URL` to your deployed URL so the links resolve from a phone.
Master switch `PHONE_NOTIFICATIONS_ENABLED=false` by default. Every notification
and decision is written to the audit log.

## Symbols & the opportunity scanner

- **Symbol registry** (`src/symbols/registry.ts`) with asset classes:
  - **Futures** (NQ, MNQ, ES, MES, YM, MYM, RTY, M2K, CL, MCL, GC, MGC) — **tradable** via TopstepX.
  - **Stocks** (AAPL, TSLA, NVDA, AMD, MSFT, AMZN, META, GOOGL) and **crypto**
    (BTCUSD, ETHUSD, SOLUSD) — **watchlist / analysis-only** for now.
  - Manual symbol entry stays available; unknown symbols are analysis-only and
    **never tradable**. The risk manager and order executor both block any
    non-futures symbol (`untradable-symbol`).
- **Scanner + Avrrio Score** (`src/scanner/scanner.ts`) ranks the universe so a
  beginner sees "today's best setups and why" instead of a blank symbol box.
  Score = Trend 30% · Volume 20% · News 20% · Momentum 15% · Risk 15% (0–100),
  with a plain-language "why it's interesting" breakdown per symbol.
  - Dashboard: **🔥 Top opportunities** panel + asset-class/symbol dropdowns with
    tradable/watchlist validation.
  - CLI: `npm run dev -- scan 5`. API: `GET /api/scan?classes=futures,stocks&limit=5`.

## Modules

| Module | Path |
|--------|------|
| Symbol registry (asset classes, tradability) | `src/symbols/registry.ts` |
| Opportunity scanner + Avrrio Score | `src/scanner/scanner.ts` |
| Read-only data + guarded order submit | `src/topstep/client.ts` |
| Market data reader | `src/market/marketData.ts` |
| Risk manager (full safety stack) | `src/risk/` |
| Predefined setups | `src/setups/` |
| News reader | `src/news/newsReader.ts` |
| AI consensus (Claude/OpenAI/TradeGPT) | `src/ai/consensus.ts` |
| Recommendations + order executor | `src/execution/` |
| Kill switch | `src/safety/killSwitch.ts` |
| Audit log | `src/audit/auditLog.ts` |
| Password auth | `src/auth/auth.ts` |
| Trade journal | `src/journal/tradeJournal.ts` |
| Dashboard server + UI | `src/server.ts`, `src/dashboard/` |

## Quick start

```bash
npm install
cp .env.example .env        # set DASHBOARD_PASSWORD; keys optional for offline mode
npm test                    # 12 safety/risk unit tests
npm run build && npm start  # dashboard (uses PORT, else DASHBOARD_PORT=4317)
```

CLI:

```bash
npm run dev -- propose NQ long 1 20000 19960 20080
npm run dev -- recommendations
npm run dev -- approve <id>        # paper unless LIVE_TRADING_ENABLED=true
npm run dev -- kill on "stand down"
```

## Deployment (Render)

A [`render.yaml`](render.yaml) blueprint is included. Build: `npm install && npm run build`;
start: `npm start`. Set secrets (`DASHBOARD_PASSWORD`, API keys) in the Render
dashboard. The server binds to Render's `PORT` automatically.

Docs: [setup](docs/setup.md) · [risk rules](docs/risk-rules.md) · [strategy](docs/strategy-notes.md)

## Status

Phases 1–3 scaffolded. **Live trading and semi-autonomous execution are OFF by
default** and require explicit opt-in. Confirm ProjectX endpoint paths against
your account before enabling live mode (see [docs/setup.md](docs/setup.md)).
