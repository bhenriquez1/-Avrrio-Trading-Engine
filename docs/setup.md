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
# CLI
npm run dev -- account
npm run dev -- snapshot NQ
npm run dev -- evaluate NQ long 1 20000 19960 20080
npm run dev -- journal

# Dashboard (http://localhost:4317)
npm run dashboard

# Type-check & tests
npm run typecheck
npm test
```

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
