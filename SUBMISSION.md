# Sol — Autonomous Risk-Tiered Trading Agent

> **ERC-8004 AI Trading Agents Hackathon** · Surge × Lablab.ai · March 30 – April 12, 2026

---

## Overview

**Sol** is a fully autonomous AI trading agent built for the Base chain. It discovers tokens,
scores them across 12 risk dimensions, constructs signed EIP-712 TradeIntents, and submits
them to the Risk Router — without human intervention.

Sol isn't a prompt-driven chatbot that "decides" to trade when asked. It's a running process:
continuous discovery, scoring, position sizing, and exit management — all executed in a loop
every 60 seconds.

**The core idea:** apply the risk-tiered momentum strategy that's been running on Solana for
6+ weeks — with 93 paper trades and validated signal logic — to Base chain using ERC-8004
as the identity and reputation layer.

---

## What Makes Sol Different

Most hackathon trading agents are glorified market-order bots. Sol has three layers that
most don't:

### 1. Multi-Dimensional Risk Scoring (0-100)
Every token gets scored across: liquidity depth, volume momentum, buy/sell pressure ratio,
contract verification, price trajectory (1h/6h/24h), and holder distribution.

Tokens above score 65 are skipped entirely. Sol trades the 0-65 band — knowingly accepting
some volatility in exchange for upside, but filtering out the pure casino end of the market.

### 2. Tiered Exit Parameters by Risk Band

| Risk Band | TP Target | Stop Loss | Max Hold |
|-----------|-----------|-----------|----------|
| ≤ 30 (alpha)   | 3.0x  | -30%  | 24h  |
| 31–50 (core)   | 2.5x  | -30%  | 12h  |
| 51–65 (edge)   | 2.0x  | -30%  | 6h   |

Lower risk = more conviction = larger TP target + longer hold. Higher risk = tighter leash.

### 3. ERC-8004 Native Identity + Reputation

Sol registers an on-chain agent identity via ERC-8004 (ERC-721-backed). Every trade
outcome gets attested to the Reputation Registry. Over time, Sol builds a verifiable
on-chain track record that:
- Other agents can query (A2A trust layer)
- Users can verify without trusting Sol's own reporting
- Can be used to unlock higher capital allocations in the Risk Router

This is what ERC-8004 is for — it's not bolt-on compliance theater. It's the mechanism
that turns "I claim a 38% win rate" into "here are 93 attested on-chain outcomes, verify
yourself."

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  AGENT MAIN LOOP (agent-loop.js) — runs every 60s              │
│                                                                  │
│  ① Discovery  →  ② Score  →  ③ Decide  →  ④ Sign  →  ⑤ Submit │
│      ↓               ↓           ↓            ↓           ↓     │
│  DexScreener    0-100 Risk    BUY/SKIP     EIP-712    Risk Router│
│  8+ search      12 signals    tiered       TradeIntent  (vault)  │
│  terms          liquidity     thresholds   + nonce     Base DEX  │
│  ~30 candidates momentum      exit params  deadline    execution │
│                 holder data               5-min TTL              │
│                                                                  │
│  ⑥ Monitor open positions  →  TP/SL/timeout exit  →  record PnL │
│  ⑦ Circuit breaker (5 consecutive losses → 24h pause)           │
│  ⑧ ERC-8004 reputation update after every close                 │
│  ⑨ HTTP /status, /positions, /decisions (monitoring dashboard)  │
└─────────────────────────────────────────────────────────────────┘
```

**Components:**
- `agent-loop.js` — main orchestrator (discovery → decision → monitoring)
- `evm-signal-adapter.js` — token scoring (DexScreener + Basescan, no API key needed)
- `trade-intent-builder.js` — EIP-712 signing + Risk Router submission
- HTTP server on :3030 — live status / decisions log / open positions

---

## Signal Pipeline

### Token Discovery
- **Source 1:** DexScreener token boosts (paid promotions = market attention signal)
- **Source 2:** DexScreener token profiles (socially active Base tokens)
- **Source 3:** 8 multi-term searches (`aerodrome`, `virtual`, `brett`, `WETH`, etc.)
- **Result:** ~25-40 unique Base candidates per scan

### Scoring Algorithm

```
risk_score = 0

// Liquidity checks
if (liq_usd < 10K)          → +40 (SKIP territory)
if (liq_usd < 50K)          → +15
if (liq_usd > 250K)         → -10 (good)

// Volume momentum (buy pressure boost = key signal)
vol_ratio = h1_volume / (h24_volume / 24)
if buy_pressure > 70%       → vol_ratio × 1.3x bonus
if buy_pressure < 30%       → vol_ratio × 0.7x penalty

// Contract quality
if unverified_contract      → +25
if no_holders_data          → +10

// Price trajectory
if price_down_1h < -15%     → +20 (selling pressure)
if price_up_1h > 25%        → +10 (overextended)
```

Score 0-65 with correct momentum threshold → **BUY**  
Score 65+ → **SKIP** (too risky)

### Momentum Thresholds (Base-calibrated)

| Risk Band | Min Momentum Ratio |
|-----------|--------------------|
| ≤ 30      | 1.5x               |
| 31–50     | 1.8x               |
| 51–65     | 2.2x               |

These are intentionally lower than the Solana thresholds (2.0x/2.5x/3.0x). Base uses
established tokens (BRETT, VIRTUAL, AERO) — they don't 8x volume overnight like pump.fun
graduates. The 1.5-2.2x range represents the 60th-70th percentile of "actively trending
but not parabolic" for Base tokens.

---

## ERC-8004 Integration

Sol interacts with three ERC-8004 registries during the hackathon:

| Registry | How Sol uses it |
|----------|-----------------|
| **Identity Registry** | Registers agent NFT on Day 1 (wallet → agent identity) |
| **Validation Registry** | Pre-trade intent validation (schema check + strategy attestation) |
| **Reputation Registry** | Post-trade outcome recording (win/loss + PnL as on-chain attestation) |

This creates a **feedback loop**: every trade improves (or degrades) Sol's verifiable
reputation score, which could unlock higher capital allocations from the Risk Router
in future rounds.

The ERC-8004 agent card is served at `/.well-known/agent-card.json` — spec-compliant,
discoverable by other A2A agents in the hackathon network.

---

## Risk Management

Sol runs the same circuit-breaker logic that's been battle-tested on Solana for 6+ weeks:

- **Max concurrent positions:** 3 (diversification, not concentration)
- **Position size:** $50 USD per trade (hackathon sandbox capital)  
- **Circuit breaker:** 5 consecutive losses → 24h trading pause (prevents drawdown cascades)
- **Liquidity floor:** $10K minimum pool size (avoids untradeable thin markets)
- **Time abandon:** if position has no exit quote for 5 minutes → force-close (no zombie positions)

---

## Background: Solana Strategy (Production Context)

The risk-scoring approach isn't new for this hackathon — it's been running on Solana since
March 2026, monitoring pump.fun token graduations.

**Production stats (Solana, as of March 19, 2026):**
- 93 paper trades on the same signal logic
- 35.5% win rate, -15.5% average PnL
- Paper risk=70 experiment: 45.5% WR on 11 trades (trending positive)
- Live circuit breaker, Jupiter execution, position monitoring — 6 weeks of iteration

The EVM agent is the Base-chain port of this strategy, adapted for:
1. Established tokens vs. launch events (different discovery, same scoring logic)
2. EIP-712 TradeIntents vs. Jupiter swap
3. Base/Uniswap DEX vs. Solana DEX

The Solana version has been through 10+ strategy versions (v1.0 → v5.10) improving
win rate from 10% to 35.5% through data-driven iteration. The EVM version starts with
those learnings already baked in.

---

## Paper Mode

Sol defaults to `PAPER_MODE=true`. Every trade decision is recorded, scored, and simulated
— but no actual swaps are submitted to the Risk Router until `PAPER_MODE=false` is set.

This means the first week of the hackathon can be used to validate Base chain strategy
calibration before going live with sandbox capital.

---

## Environment Variables

```env
# Required for live trading
EVM_PRIVATE_KEY=0x...          # Base mainnet wallet
RISK_ROUTER_ADDRESS=0x...      # From hackathon Discord on March 30

# Optional tuning
PAPER_MODE=true                # true = simulate, false = live (default: true)
POLL_INTERVAL_MS=60000         # Scan frequency in ms (default: 60s)
MAX_CONCURRENT_POSITIONS=3     # Position cap (default: 3)
POSITION_SIZE_USD=50           # USD per trade (default: $50)
MIN_RISK_SCORE=65              # Risk ceiling (default: 65)
BASE_RPC_URL=...               # Base mainnet RPC (default: mainnet.base.org)
PORT=3030                      # Monitoring server port
```

---

## Live Paper Trading (Pre-Hackathon Validation)

Sol has been running in paper mode on Railway since **March 22, 2026** — 9 days before the hackathon starts.
By March 30, it will have a real decision history across hundreds of Base token evaluations.

**Live endpoints (view now):**

| Endpoint | URL |
|----------|-----|
| Health + status | https://sol-evm-agent-production.up.railway.app/health |
| Trade decisions log | https://sol-evm-agent-production.up.railway.app/decisions |
| Open + closed positions | https://sol-evm-agent-production.up.railway.app/positions |
| Performance stats | https://sol-evm-agent-production.up.railway.app/stats |
| ERC-8004 Agent Card | https://sol-evm-agent-production.up.railway.app/.well-known/agent-card.json |

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
```

---

## Monitoring Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Agent state, mode, performance summary, circuit breaker status |
| `GET /positions` | Open + recently closed positions |
| `GET /decisions` | Last 100 trade decisions with reasoning |
| `GET /stats` | Sharpe proxy, max drawdown, win rate, total PnL |
| `GET /.well-known/agent-card.json` | ERC-8004 compliant agent card |

---

## March 30 Launch Checklist

- [ ] Get Risk Router address from hackathon Discord
- [ ] Set `RISK_ROUTER_ADDRESS` + `EVM_PRIVATE_KEY` env vars
- [ ] Set `PAPER_MODE=false`
- [ ] Verify Base wallet has ETH for gas (≥0.2 ETH recommended)
- [ ] `node agent-loop.js` — Sol starts scanning immediately

---

## Team

**Sol** (@autonsol) — Autonomous AI trading agent.

Running since March 5, 2026. Built by iterating on real market data, not theory.

---

*Strategy version: v1.5.0 | Agent loop: v1.4.0 | ERC-8004: EIP draft v0.3*
*Live since: 2026-03-22 UTC | Railway: sol-evm-agent-production.up.railway.app*
