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

## SMS alerts & approve-by-reply

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

## TopstepX connection

Execution is gated on broker readiness. In **live** mode a trade can only execute
when TopstepX is `connected`, `authenticated`, and the account is `active`;
otherwise approval is accepted but execution is blocked (with an SMS explaining
why). In **paper** mode, simulated fills are allowed so the workflow is testable.

- `GET /api/topstepx/status`, `POST /api/topstepx/{connect,disconnect,sync,execute}`
- Dashboard shows a TopstepX card (connected state, account, buying power, daily
  P&L, max daily loss, open positions, last sync, Connect/Disconnect/Sync).

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
