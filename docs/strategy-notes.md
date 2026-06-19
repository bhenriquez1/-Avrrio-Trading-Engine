# Strategy notes

This project is **not** a "make me rich" bot. Its thesis: most traders fail from
oversizing, revenge trading, ignoring stops, and breaking rules — not from a
lack of signals. An AI that *prevents those mistakes* can be worth more than one
that predicts direction.

## Phased plan

**Phase 1 — analyst + risk manager (this repo).**
- Connect to TopstepX/ProjectX, read account + market data.
- Risk manager checks every idea against account rules and discipline policy.
- Claude analyzes setups and returns buy/sell/no-trade + stop/target/confidence.
- Everything is journaled. **The human decides.** No orders are placed.

**Phase 2 — suggest + track.**
- Claude suggests trades; the engine tracks paper performance over many trades.
- Build a track record before trusting any automation.

**Phase 3 — limited automation.**
- Only after a strategy has demonstrated a real edge over hundreds of trades,
  behind explicit, separately-reviewed execution code with hard kill-switches.

## Multi-model consensus (future)

A useful pattern is to ask more than one model and trade only on agreement:

```
Claude:   Long NQ
OpenAI:   Long NQ      -> high confidence
TradeGPT: Long NQ
```

vs.

```
Claude:   Long
OpenAI:   Neutral      -> low confidence, no trade
TradeGPT: Short
```

Phase 1 ships Claude only (see `src/ai/claudeAnalysis.ts`). Additional providers
can be added as sibling services returning the same `ClaudeAnalysis` shape, with
a small aggregator that requires consensus.

## Architecture

```
TradingView (charts/alerts)        TopstepX / ProjectX API (read-only)
            \                       /
             v                     v
             Avrrio Trading Engine
             ├─ market data reader
             ├─ risk manager   <-- the brain
             ├─ trade journal
             └─ AI analysis (Claude)
                       |
                       v
              Dashboard / CLI  -> Brian decides
```
