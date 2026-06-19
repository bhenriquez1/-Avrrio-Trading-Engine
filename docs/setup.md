# Setup

## Prerequisites

- Node.js 20+
- A TopstepX account with the **API** tab enabled (ProjectX linking)
- (Optional, recommended) An Anthropic API key for Claude analysis

## Install

```bash
npm install
cp .env.example .env
# edit .env with your credentials
```

## Run

```bash
# Dashboard (http://localhost:4317, or PORT on a PaaS)
npm run dashboard          # dev (tsx)
npm run build && npm start # production build

# CLI workflow
npm run dev -- account
npm run dev -- snapshot NQ
npm run dev -- evaluate NQ long 1 20000 19960 20080   # one-off check
npm run dev -- propose  NQ long 1 20000 19960 20080   # AI consensus + risk -> recommendation
npm run dev -- recommendations
npm run dev -- approve <id>            # paper unless LIVE_TRADING_ENABLED=true
npm run dev -- reject  <id>
npm run dev -- kill on "reason"        # engage emergency stop;  kill off to clear

# Type-check & tests
npm run typecheck
npm test
```

## Safety flags

All execution flags default to the safe value. To enable real trading you must
explicitly set them (see `.env.example`):

- `LIVE_TRADING_ENABLED=false` — approvals are paper until true.
- `SEMI_AUTONOMOUS_ENABLED=false` — no auto-execution until true.
- `KILL_SWITCH=false` — set true to hard-block all trading (cannot be cleared at runtime).
- `DASHBOARD_PASSWORD` — set this before exposing the dashboard.
- `DAILY_MAX_LOSS`, `MAX_POSITION_SIZE`, `MAX_TRADES_PER_DAY`, `MAX_RISK_PER_TRADE` — risk limits.

## Deploy on Render

The included `render.yaml` defines a Node web service:
build `npm install && npm run build`, start `npm start`. Set secrets
(`DASHBOARD_PASSWORD`, `ANTHROPIC_API_KEY`, `TOPSTEP_*`) in the Render dashboard.
The server listens on Render's `PORT` automatically.

If `TOPSTEP_API_KEY` / `TOPSTEP_USERNAME` are not set, the engine runs in
**offline mode** with deterministic demo data so you can develop everything
except real market/account reads.

## Connecting TopstepX / ProjectX

1. In TopstepX, open the **API** tab and generate an API key.
2. Note the ProjectX gateway base URL for your account and set
   `TOPSTEP_API_BASE_URL` accordingly.
3. Set `TOPSTEP_USERNAME` and `TOPSTEP_API_KEY` in `.env`.

The client in `src/topstep/client.ts` implements a ProjectX-style
login-with-key flow and read-only account/market endpoints. The exact paths
and payloads can differ by gateway version — confirm them against the ProjectX
API docs and adjust the `request(...)` calls if a route returns 404.

> The client has **no order-placement methods** by design. See
> [risk-rules.md](./risk-rules.md) and the README "Safety model".
