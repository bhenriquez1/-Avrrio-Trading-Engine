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

## Modules

| Module | Path |
|--------|------|
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
