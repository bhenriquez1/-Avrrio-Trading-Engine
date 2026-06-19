# Avrrio Trading Engine

A read-only **trading analyst + AI risk manager** for TopstepX / ProjectX
futures accounts. It connects to the TopstepX API, reads your account rules and
market data, runs trade ideas through a risk manager, asks Claude for analysis,
and journals everything — so a human can make better, rule-compliant decisions.

> **Claude = analyst + risk manager, not gambler.** This is an experiment in
> *preventing* bad trades (oversizing, no stops, breaking account rules), which
> is often worth more than predicting direction.

## Safety model

This phase is **read-only and decision-support only**:

- The TopstepX client (`src/topstep/client.ts`) has **no order-placement
  methods**. It can only read account, quote, and bar data.
- `AVRRIO_ALLOW_LIVE_ORDERS` exists purely as an auditable flag — **no code
  sends orders regardless of its value.**
- The risk manager can **block** an idea; blocked ideas are journaled as blocked.
- Live execution is a deliberate, separately-reviewed future phase. See
  [docs/strategy-notes.md](docs/strategy-notes.md).

## What it does

1. Connects to TopstepX/ProjectX (read-only).
2. Reads account balance, day P&L, and rules (daily loss, drawdown, max size).
3. Reads market data (quotes + bars) and derives basic structure.
4. Runs trade ideas through the **risk manager** (account rules + discipline policy).
5. Asks **Claude** for a buy/sell/no-trade recommendation with stop, target, and confidence.
6. **Journals** every idea with its risk-approval state.
7. Serves a **dashboard** showing account status, risk limits, ideas, and rule violations.

If credentials are missing, it runs in **offline mode** with demo data so the
whole engine is developable without a live account or API key.

## Modules

| Module | Path | Role |
|--------|------|------|
| API client | `src/topstep/client.ts` | Read-only TopstepX/ProjectX access |
| Account/risk-rule reader | `src/topstep/client.ts` → `getAccount()` | Account + rule data |
| Market data reader | `src/market/marketData.ts` | Quotes, bars, structure |
| Risk manager | `src/risk/` | Approves/blocks ideas — the core |
| Trade journal | `src/journal/tradeJournal.ts` | File-backed paper journal & stats |
| AI analysis | `src/ai/claudeAnalysis.ts` | Claude-backed analyst |
| Dashboard | `src/server.ts` + `src/dashboard/` | Read-only web UI |

## Quick start

```bash
npm install
cp .env.example .env        # fill in credentials (optional for offline mode)
npm test                    # risk-manager unit tests
npm run dashboard           # http://localhost:4317
```

CLI:

```bash
npm run dev -- account
npm run dev -- evaluate NQ long 1 20000 19960 20080
```

See [docs/setup.md](docs/setup.md), [docs/risk-rules.md](docs/risk-rules.md),
and [docs/strategy-notes.md](docs/strategy-notes.md) for details.

## Status

Phase 1 (analyst + risk manager + journal + dashboard). No automated execution.
