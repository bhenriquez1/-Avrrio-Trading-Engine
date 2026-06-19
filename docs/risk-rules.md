# Risk rules

The risk manager (`src/risk/riskManager.ts`) is the core of the project. It
answers a single question for any trade idea: **does this respect the account
rules and the operator's discipline policy?** It does not predict direction.

## Two layers of rules

### 1. Account rules (from Topstep)

Read from the account (`AccountRules`):

- `maxDailyLoss` — daily loss cap before the account locks.
- `maxDrawdown` — trailing/overall drawdown limit.
- `maxPositionSize` — largest position (contracts) allowed.

### 2. Engine discipline policy (`src/risk/rules.ts` → `DEFAULT_POLICY`)

Behavioural guardrails that prevent the common ways traders blow up:

- `minRewardRiskRatio` (default 1.5) — reject poor reward/risk setups.
- `maxRiskFractionOfDailyLoss` (default 0.5) — warn when a single trade risks
  more than half the daily loss budget (concentration risk).
- `requireStopLoss` (default true) — every idea must define a stop.

## Checks performed

| Rule | Severity | Meaning |
|------|----------|---------|
| `size` | block | Size must be > 0 |
| `stop-required` | block | A stop loss is mandatory |
| `stop-side` | block | Stop must be below entry (long) / above (short) |
| `target-side` | block | Target must be above entry (long) / below (short) |
| `reward-risk` | block | R:R below the policy minimum |
| `max-position-size` | block | Size exceeds account max |
| `daily-loss-budget` | block | Risk exceeds remaining daily-loss budget |
| `risk-concentration` | warn | Single trade risks a large share of the budget |

A trade is **approved** only when there are no `block`-severity violations.

## Dollar risk math

`riskAmount = |entry − stop| × size × pointValue(symbol)`

Point values live in `POINT_VALUES` (`src/risk/rules.ts`). Add products there as
you trade them. Reward/risk is `|target − entry| / |entry − stop|`.

## Adjusting the policy

Construct `new RiskManager(customPolicy)` with your own `EngineRiskPolicy` to
tighten or loosen the discipline rules without touching account rules.
