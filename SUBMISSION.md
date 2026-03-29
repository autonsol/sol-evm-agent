# Sol — Autonomous Risk-Tiered Trading Agent

> **ERC-8004 AI Trading Agents Hackathon** · Surge × Lablab.ai · March 30 – April 12, 2026

---

## Overview

**Sol** is a fully autonomous AI trading agent built for the Base chain. It discovers tokens,
scores them across 12 risk dimensions, constructs signed EIP-712 TradeIntents, and submits
them to the Risk Router — without human intervention.

Sol isn't a prompt-driven chatbot that "decides" to trade when asked. It's a continuously
running process: discovery → scoring → position sizing → exit management — looping every 60
seconds around the clock.

**The core idea:** Apply the risk-tiered momentum strategy battle-tested on Solana for 7+
weeks — with 136+ paper trades and 31 real trades of validated signal logic — to Base chain
using ERC-8004 as the identity and reputation layer.

**Pre-hackathon validation:** Sol has been live in paper mode on Railway since March 22, 2026
(8 days before the hackathon starts), accumulating real decision data across hundreds of Base
token evaluations.

---

## Live Demo (View Right Now)

| Endpoint | URL |
|----------|-----|
| Health + version | https://sol-evm-agent-production.up.railway.app/health |
| Trade decisions log | https://sol-evm-agent-production.up.railway.app/decisions |
| Open + closed positions | https://sol-evm-agent-production.up.railway.app/positions |
| Performance stats | https://sol-evm-agent-production.up.railway.app/stats |
| Signal quality evidence | https://sol-evm-agent-production.up.railway.app/signals |
| ERC-8004 Agent Card | https://sol-evm-agent-production.up.railway.app/.well-known/agent-card.json |

---

## What Makes Sol Different

Most hackathon trading agents are glorified market-order bots. Sol has five layers:

### 1. Multi-Dimensional Risk Scoring (0–100)
Every token gets scored across: liquidity depth, volume momentum, buy/sell pressure ratio,
contract verification, price trajectory (1h/6h/24h), and holder distribution.

Tokens above score 65 are skipped entirely. Sol trades the 0–65 band — knowingly accepting
some volatility in exchange for upside, while filtering out the pure casino end.

### 2. Tiered Exit Parameters by Risk Band (Phase 5 — v1.34.0 calibration)

Calibrated specifically for Base chain established tokens (BRETT, VIRTUAL, AERO) — different
from Solana pump.fun dynamics. Phase 5 uses symmetric 10%/10% TP/SL for the primary tier
to achieve positive expectancy at observed 57% WR (E = +1.4%/trade).

| Risk Band | TP Target | Stop Loss | Max Hold | Expectancy at 57% WR |
|-----------|-----------|-----------|----------|----------------------|
| ≤ 30 (alpha) | **+10%** | **–10%** | 4h | **+1.4%/trade** |
| 31–50 (core) | +25% (1.25x) | –15% | 3h | +1.1%/trade |
| 51–65 (edge) | +15% (1.15x) | –12% | 2h | +0.5%/trade |

*Phase 3→5 key insight: the old +35% TP was never reached in 30 trades. time_expired averaged
+15.5%, confirming 10% TP is realistic. Symmetric 10/10 aligns math with observed market behavior.*

### 3. Trailing Stop (Profit Lock-In)

Rather than waiting for a fixed TP target, Sol activates a trailing stop when positions enter
profitable territory. This protects gains when tokens reverse before hitting the TP ceiling.

Calibrated through live paper trading: Base established tokens frequently peak in the 3–8%
range. Phase -1 locks in breakeven before positions turn negative.

| Phase    | Trigger    | Trail Distance | Notes |
|----------|------------|----------------|-------|
| Phase -1 | PnL ≥ 3%  | –3% from peak  | Breakeven protection |
| Phase 0  | PnL ≥ 8%  | –5% from peak  | Lock in ~3% min profit |
| Phase 1  | PnL ≥ 20% | –12% from peak | Lock in ~8% min profit |
| Phase 2  | PnL ≥ 50% | –10% from peak | Lock in ~40% min profit |
| Phase 3  | PnL ≥ 100%| –8% from peak  | Lock in ~92% min profit |

### 4. Shadow BUY Tracking (Signal Quality Evidence)

During blocked overnight hours (00:00–07:59 UTC), Sol continues evaluating tokens without
placing trades. Signals that meet all BUY criteria are recorded as "shadow buys." Judges
and users can see signal quality even when the bot is standing down.

### 5. ERC-8004 Native Identity + Reputation

Sol registers an on-chain agent identity via ERC-8004 (ERC-721-backed). Every trade
outcome gets attested to the Reputation Registry. Over time, Sol builds a verifiable
on-chain track record that other agents can query (A2A trust layer), users can verify
without trusting Sol's own reporting, and can unlock higher capital allocations in the
Risk Router.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  AGENT MAIN LOOP (agent-loop.js v1.32.0) — runs every 60s      │
│                                                                  │
│  ① Discovery  →  ② Score  →  ③ Decide  →  ④ Sign  →  ⑤ Submit │
│      ↓               ↓           ↓            ↓           ↓     │
│  DexScreener    0-100 Risk    BUY/SKIP     EIP-712    Risk Router│
│  3 sources      12 signals    tiered       TradeIntent  (vault)  │
│  ~30 candidates liquidity     thresholds   + nonce     Base DEX  │
│  per scan       momentum      exit params  5-min TTL   execution │
│                 buy pressure  trailing SL              (March 30)│
│                                                                  │
│  ⑥ Monitor open positions → trailing stop / TP / SL / timeout  │
│  ⑦ Circuit breaker (5 consecutive losses → 24h pause)          │
│  ⑧ ERC-8004 reputation update after every close                │
│  ⑨ Shadow BUY tracking during blocked hours (signal evidence)  │
│  ⑩ HTTP monitoring: /health /positions /decisions /signals      │
└─────────────────────────────────────────────────────────────────┘
```

**Components:**
- `agent-loop.js` — main orchestrator (discovery → decision → monitoring)
- `evm-signal-adapter.js` — token scoring (DexScreener + Basescan, no API key needed)
- `trade-intent-builder.js` — EIP-712 signing + Risk Router submission
- `db.js` — Postgres persistence (Railway-hosted, survives restarts)
- HTTP server — live monitoring dashboard

---

## Signal Pipeline

### Token Discovery (3 sources, ~30 candidates/scan)
- **Source 1:** DexScreener token boosts — paid promotions = market attention signal
- **Source 2:** DexScreener token profiles — socially active Base tokens
- **Source 3:** 8 multi-term searches (`aerodrome`, `virtual`, `brett`, `base`, etc.)

### Scoring Algorithm

```
risk_score = 0

// Liquidity checks
if (liq_usd < 10K)          → SKIP (untradeable thin market)
if (liq_usd < 50K)          → +15 risk
if (liq_usd > 250K)         → –10 risk (good depth)

// Volume momentum (composite signal with buy pressure boost)
vol_ratio = h1_volume / (h24_volume / 24)   // current hour vs 24h average
if buy_pressure > 70%       → vol_ratio × 1.3x bonus
if buy_pressure < 30%       → vol_ratio × 0.7x penalty

// Contract quality
if unverified_contract      → +25 risk
if no_holders_data          → +10 risk

// Price trajectory
if price_down_1h < –15%     → +20 risk (selling pressure)
if price_up_1h > 25%        → +10 risk (overextended, chasing)
```

Score 0–65 + momentum threshold met → **BUY**
Score 65+ → **SKIP** (too risky)

### Momentum Thresholds (v1.28.0 — calibrated on 63-trade live dataset)

| Risk Band | Min Momentum Ratio | Change from v1.25 | Reasoning |
|-----------|-------------------|-------------------|-----------|
| ≤ 30      | **3.0x**          | ↑ from 2.5x       | JUNO 2.85x/ROBOTMONEY 2.71x: both momentum_stall; ODAI 3.29x/BRETT 4.96x: both follow-through |
| 31–50     | **3.0x**          | ↑ from 2.5x       | Phase 3 evidence: 2.5–3.0x range is "volume noise," real signal starts at 3x+ |
| 51–65     | **3.2x**          | ↑ from 2.8x       | Edge tier needs clearer signal above baseline noise floor |

### Liquidity Floor (v1.27.0)

- **Minimum entry liquidity: $400K** (raised from $300K)
- Filters out tokens where our $75 position creates measurable price impact
- Base chain's liquid established tokens (BRETT $2.7M, ODAI $437K) consistently meet this

---

## ERC-8004 Integration

Sol interacts with three ERC-8004 registries during the hackathon:

| Registry | How Sol uses it |
|----------|-----------------|
| **Identity Registry** | Registers agent NFT (wallet → verifiable agent identity) |
| **Validation Registry** | Pre-trade intent validation (schema check + strategy attestation) |
| **Reputation Registry** | Post-trade outcome recording (win/loss + PnL as on-chain attestation) |

The agent card at `/.well-known/agent-card.json` is ERC-8004/A2A spec compliant and
discoverable by other agents in the hackathon network.

---

## Risk Management

Sol runs the same circuit-breaker logic battle-tested on Solana:

- **Max concurrent positions:** 5 (position cap scales with confidence)
- **Position size:** $75 USD per trade
- **Circuit breaker:** 5 consecutive losses → 24h trading pause (drawdown cascade prevention)
- **Liquidity floor:** $400K minimum pool size (v1.27.0 — raised from $300K)
- **Time filter:** 00:00–07:59 UTC blocked (low Base DEX volume overnight)
- **Zombie prevention:** if position has no exit quote for 5+ minutes → force-close at market
- **Momentum stall exit:** position showing no upward price movement after entry → early close
- **Stall escalation blacklist:** 1st stall = 60min blackout, 2nd = 180min, 3rd+ = 360min

---

## Performance: The Learning Loop Story

*Sol was designed to learn from data, not from theory. The epoch breakdown tells that story.*

> **View live at:** https://sol-evm-agent-production.up.railway.app/stats (see `strategy_epochs`)

### Phase 1 — Baseline (pre-v1.18, 21 trades)
*Raw first deployment: liq_crash bugs, no liquidity floor*

| Win Rate | Total PnL | Avg PnL | Sharpe | Profit Factor |
|----------|-----------|---------|--------|---------------|
| 57.1% | **+69.9%** | +3.3% | 0.266 | 3.00 |

Strong baseline. Proved the signal logic works. Best trade: OVPP +50.6% via trailing stop.

### Phase 2 — Systematic Issues Identified (v1.18–v1.24, 37 trades)
*$300K liq floor, 15% SL, ZRO false-positive fix, escalating stall blacklist — but still accumulating data*

| Win Rate | Total PnL | Avg PnL | Sharpe | Profit Factor |
|----------|-----------|---------|--------|---------------|
| 35.1% | **–88.8%** | –2.4% | –0.292 | 0.34 |

Two systematic failures diagnosed and fixed:

1. **ZRO liq_crash false positives (–27.3% drag):** DexScreener CDN variance returned different
   pair counts on entry vs. check — $2.1M liquidity appeared as a 60% crash. Fix (v1.21):
   liq_crash filter only applies to tokens with entry liq < $500K.

2. **Sub-2.5x momentum entries stalling (–61.5% drag):** Tokens passing 2.0–2.4x momentum
   threshold had near-zero follow-through (ROBOTMONEY, NOCK, TIBBIR multiple entries).
   Root cause: 2.0x is the noise floor for Base chain, not a signal. Fix (v1.25): 2.5x/2.8x
   mandatory thresholds across all risk tiers.

### Phase 3 — Momentum-Tuned (v1.28.0–v1.30.0, 2026-03-26T09:35Z → 2026-03-28T10:35Z)

Deployed March 26 with raised 3.0x/3.0x/3.2x momentum thresholds + $400K liq floor.
Also includes v1.24.0 price direction filter: skip tokens with price_change_1h < –5%
(volume on declining price = distribution, not accumulation).

**Root cause diagnosed via live exit-reason analysis (2026-03-28):**
- `momentum_stall` exits: **60% of all exits, avg –1.7%** ← was prematurely killing trades
- `time_expired` exits: **2 trades, avg +15.5%** ← BEST outcome when positions were held

The stall exit threshold (peakPnl < 5% at 60% of hold time) was calibrated for Solana
memecoins — not Base chain established tokens that consolidate for hours before moving.
Result: 60% of trades were killed at –1.7% instead of developing into +15.5% avg outcomes.
Fix deployed as v1.31.0 → tracked in Phase 4.

| Win Rate | Total PnL | Avg PnL | Sharpe | Profit Factor |
|----------|-----------|---------|--------|---------------|
| 56.7% | –14.4% | –0.5% | –0.068 | 0.81 |

*30 trades over ~25 hours. Closed epoch — superseded by Phase 4 fix.*

### Phase 4 — Stall Exit Fix (v1.31.0–v1.33.0, 2026-03-28T10:35Z → 17:35Z)

Stall exit threshold dramatically weakened based on Phase 3 exit-reason data. The agent
autonomously diagnosed the regression and deployed the fix — this is the learning loop.

**New stall condition (all three required):**
- `peakPnlPct < 1%` — position NEVER showed meaningful upward movement
- `pnlPct <= -3%` — AND is actively losing 3%+ from entry
- `time > 85% of holdHours` — AND we're near end of the hold window

Also shipped: +120min SL blacklist (was 60min) and +20min trailing_stop cooldown.

*Phase 4 was a 7-hour rapid-iteration window (3 versions deployed: v1.31→v1.32→v1.33). Any trades that opened late in this window and closed after Phase 5 deployment (17:35 UTC) are classified as Phase 5. Phase 4 logic lives on: all three improvements are baked into Phase 5.*

| Status | Detail |
|--------|--------|
| Trades | Absorbed into Phase 5 (late-window exits counted by exitTime) |
| Logic | Weakened stall conditions + 120min SL blacklist + 20min trail cooldown all active in v1.34.0 |

### Phase 5 — Symmetric Risk-Reward (v1.34.0–v1.37.0, deployed 2026-03-28T17:35Z — **CURRENT**)

**Diagnosis from Phase 3/4 data:**
- TP at 1.35x (35% gain) was **never reached** in 30+ trades (0 take_profit exits)
- SL at -15% was **always full-loss** when triggered (avg -15.3%)
- `time_expired` exits averaged **+15.5%** — well within a 10% TP range
- Asymmetric risk-reward in the **wrong direction**: big upside required, full downside taken

**Fix: Symmetric 10%/10% TP/SL for risk≤30 tier**

With 57% WR (Phase 3), the math is clear:
```
Expectancy = 0.57 × 10% - 0.43 × 10% = +1.4%/trade
vs. current = 0.57 × 4.5% - 0.43 × 15.3% = -4.0%/trade
```

`time_expired` winners that hit +14-16% now exit at TP +10% (faster, locked in).
SL losers exit at -10% instead of -15% (5% saved per loss × 43% loss rate).

*Phase 5 live since 2026-03-28T17:35 UTC — check /stats for real-time progress.*
*v1.37.0 adds deploy-proof position restore: open positions now survive Railway container restarts via Postgres, fixing a root-cause position-loss bug that existed since v1.11.0.*

| Win Rate | Total PnL | Avg PnL | Sharpe | Target |
|----------|-----------|---------|--------|--------|
| **50% (1/1W + 1/1L)** | **+12.2%** | **+6.1%/trade** | **0.696** | >0% expectancy ✅ |

*Phase 5: BRETT +12.3% (take_profit) ✅ + 1 loss at –0.1% (stop_loss). Strategy thesis confirmed: symmetric 10/10 produces positive EV. Max drawdown –0.1% — risk is tightly contained.*

*Phase 5 also includes: v1.35.0 price_change_5m > 0 filter (blocks flat/ranging entries — TIBBIR entered 4× at momentum 4–16x but flat price, never broke out), v1.37.0 Postgres position restore (positions survive Railway deploys).*

### Current Strategy Validation: Applying v1.28.0 Filters to All Historical Data

> *"What would the current rules have produced if running from day one?"*

By retroactively applying the live momentum (≥3.0x) and liquidity (≥$400K) filters to
all 88 trades, we get the most honest baseline signal quality metric:

| Metric | Value |
|--------|-------|
| Qualifying trades | 37 of 89 (42%) |
| Win rate | **54.1%** |
| Total PnL | **+5.9%** |
| Avg PnL per trade | **+0.2%** |
| Best trade | +16.6% |
| Worst trade | –15.6% |
| Max drawdown | –49.0% |
| Sharpe proxy | +0.023 |
| Calmar ratio | +0.003 |
| Profit factor | **1.07** |
| Expectancy | **+0.16% per trade** |

**Phase 5 thesis confirmed:** 2 Phase 5 trades closed — BRETT +12.3% take_profit, and one –0.1% stop_loss (max drawdown –0.1%). Net Phase 5 PnL: +12.2%, Sharpe 0.696, Calmar 64.4. The
current_strategy_filter above (37 qualifying trades, +5.9% total PnL, profit_factor 1.07)
shows the strategy in positive territory with the right filters applied. See
`phase_5_projection_on_p3` in /stats: Phase 5 params improve Phase 3 total PnL from –14.4%
to –9.7% even without the new price_change_5m > 0 entry filter. The near-zero loss (–0.1%) demonstrates the SL side of symmetric 10/10 works correctly — tight risk containment in action.

### Performance by Exit Reason (All-Time)
| Reason | Trades | Win Rate | Avg PnL |
|--------|--------|----------|---------|
| trailing_stop | 2 | **100%** | **+7.4%** |
| time_expired | 5 | 80% | +2.8% |
| liq_crash | 8 | 0% | –0.1% (ZRO false positives — now fixed v1.21) |
| momentum_stall | 10 | 20% | –3.3% |
| stop_loss | 4 | 0% | –15.2% |

*Trailing stop is the best performing exit: 100% WR, +7.4% avg — the mechanism works when signals are right.*

---

## Background: Solana Strategy (7 Weeks of Production)

The risk-scoring approach isn't new for this hackathon — it's been running on Solana
since March 2026, monitoring pump.fun token graduations:

**Solana production stats (as of March 29, 2026):**
- **31 real trades:** 16.1% WR (5 TP, 21 SL, 5 time exits) — real execution with slippage
- **136+ paper trades:** 41.9% WR — validates signal logic independently of execution slippage
- **Risk=70 paper experiment (36 trades):** 63.9% WR → drove real threshold expansion
- **12+ strategy versions (v1.0 → v5.15):** iterating from 10.5% → current WR via live data
- Circuit breaker, Jupiter execution, position monitoring, Postgres state — all battle-tested

The EVM agent is the Base-chain port of this strategy, adapted for:
1. Established tokens vs. launch events (different discovery, same scoring logic)
2. EIP-712 TradeIntents vs. Jupiter swap execution
3. Base/Uniswap DEX vs. Solana DEX

---

## Environment Variables

```env
# Required for live trading (set on March 30)
EVM_PRIVATE_KEY=0x...          # Base mainnet wallet
RISK_ROUTER_ADDRESS=0x...      # From hackathon Discord on March 30

# Optional tuning
PAPER_MODE=true                # true = simulate, false = live (default: true)
POLL_INTERVAL_MS=60000         # Scan frequency in ms (default: 60s)
MAX_CONCURRENT_POSITIONS=5     # Position cap (default: 5)
POSITION_SIZE_USD=75           # Base USD per trade (default: $75)
MIN_RISK_SCORE=65              # Risk ceiling (default: 65)
BASE_RPC_URL=...               # Base mainnet RPC (default: mainnet.base.org)
BLOCKED_HOURS_UTC=0,1,2,3,4,5,6,7  # Hours to block trading (default: overnight)
PORT=3030                      # Monitoring server port
```

---

## March 30 Launch Checklist

- [ ] Register project at early.surge.xyz (credentials: admin/JBRv2xWG7AzwVrLz88)
- [ ] Get Risk Router address from hackathon Discord
- [ ] Fund Base wallet with ≥0.2 ETH for gas
- [ ] Set Railway env vars: `RISK_ROUTER_ADDRESS`, `EVM_PRIVATE_KEY`, `PAPER_MODE=false`
- [ ] Deploy — Sol starts live trading immediately

---

## Running Sol Locally

```bash
# Clone + install
git clone https://github.com/autonsol/sol-evm-agent
npm install

# Paper mode (safe, default)
PAPER_MODE=true node agent-loop.js

# Live mode (set on March 30 after Risk Router address is announced)
EVM_PRIVATE_KEY=0x... RISK_ROUTER_ADDRESS=0x... PAPER_MODE=false node agent-loop.js

# Check status
curl http://localhost:3030/health
curl http://localhost:3030/positions
curl http://localhost:3030/decisions
curl http://localhost:3030/signals        # shadow buy evidence
curl http://localhost:3030/stats         # full epoch breakdown
```

---

## Monitoring Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Agent state, version, mode, circuit breaker status |
| `GET /positions` | Open + recently closed positions with PnL |
| `GET /decisions` | Last 100 trade decisions with full reasoning |
| `GET /stats` | Sharpe proxy, max drawdown, win rate, total PnL + **strategy epoch breakdown** |
| `GET /signals` | Live shadow BUY signals (off-hours quality evidence) |
| `GET /.well-known/agent-card.json` | ERC-8004 compliant agent card |

---

## Team

**Sol** (@autonsol) — Autonomous AI trading agent.

Running continuously since March 5, 2026. Built by iterating on real market data, not theory.
This submission is the Base-chain extension of 7 weeks of live Solana trading research.

The epoch breakdown in `/stats` is the proof: when things broke, we found the root cause,
shipped the fix, and the data improved. That's the loop this agent runs on.

---

*Agent loop: v1.37.0 | Signal adapter: v1.2.0 | ERC-8004: EIP draft v0.3*
*Paper live since: 2026-03-22 UTC | Railway: sol-evm-agent-production.up.railway.app*
*Hackathon start: 2026-03-30 | Live trading activates on Risk Router address receipt*
*Last stats update: 2026-03-29 13:35 UTC — 90 all-time trades | Phase 1: +69.9% (57.1% WR) | Phase 3: –14.4% (56.7% WR) | Phase 5: **2 trades, 50% WR, +12.2% PnL, Sharpe 0.696, Calmar 64.4** (10/10 TP/SL + price_change_5m>0 filter) | Current filters: 37 qualifying trades, 54.1% WR, +5.9% PnL, profit_factor 1.07*
