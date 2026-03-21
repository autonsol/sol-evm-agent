# Sol EVM Trading Agent

> **ERC-8004 AI Trading Agents Hackathon** · Surge × Lablab.ai · March 30 – April 12, 2026  
> Prize: $55,000 | Risk-adjusted leaderboard

**Sol** is a fully autonomous AI trading agent built for the Base chain. It discovers tokens, scores them across 12 risk dimensions, constructs signed EIP-712 TradeIntents, and submits them to the hackathon Risk Router — without human intervention.

[![Agent Card](https://img.shields.io/badge/ERC--8004-Agent%20Card-blue)](https://sol-mcp-production.up.railway.app/.well-known/agent-card.json)
[![Live Service](https://img.shields.io/badge/Sol%20MCP-Live-green)](https://sol-mcp-production.up.railway.app)

---

## What This Is

Sol isn't a prompt-driven chatbot that "decides" to trade when asked. It's a running process:
- **Continuous discovery** — scans DexScreener every 60s for Base chain tokens
- **Multi-dimensional risk scoring** — 12 signals → 0-100 risk score
- **Tiered position sizing** — risk band determines TP target + max hold time
- **ERC-8004 identity + reputation** — every trade outcome is on-chain attested
- **Circuit breaker** — 5 consecutive losses → 24h trading pause

The scoring approach comes from 6+ weeks running on Solana (93 paper trades, 35.5% WR). The Base chain version adapts the same risk-scoring logic to EVM.

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
│  ~30 candidates momentum      exit params  5-min TTL   execution │
│                 holder data                                       │
│                                                                  │
│  ⑥ Monitor open positions  →  TP/SL/timeout exit  →  record PnL │
│  ⑦ Circuit breaker (5 consecutive losses → 24h pause)           │
│  ⑧ ERC-8004 reputation update after every close                 │
│  ⑨ HTTP /status, /positions, /decisions (monitoring)            │
└─────────────────────────────────────────────────────────────────┘
```

**Files:**
- `agent-loop.js` — main orchestrator (~820 lines)
- `evm-signal-adapter.js` — token scoring via DexScreener + Basescan (~442 lines)
- `trade-intent-builder.js` — EIP-712 signing + Risk Router submission (~441 lines)

---

## Scoring Algorithm

Every token gets a 0-100 risk score. **Lower = safer, better trade candidate.**

| Signal | Scoring |
|--------|---------|
| Liquidity < $10K | +40 (instant skip) |
| Liquidity < $50K | +15 |
| Liquidity > $250K | -10 (good) |
| Unverified contract | +25 |
| Buy pressure > 70% (strong) | momentum × 1.3x bonus |
| Buy pressure < 30% (weak) | momentum × 0.7x penalty |
| Price down 1h > 15% | +20 |
| Price up 1h > 25% | +10 (overextended) |
| No holders data | +10 |

Score 0-65 + momentum threshold met → **BUY**  
Score > 65 → **SKIP**

### Momentum Thresholds (Base-calibrated)

| Risk Band | Min Momentum Ratio |
|-----------|--------------------|
| ≤ 30 (alpha) | 1.5x |
| 31–50 (core) | 1.8x |
| 51–65 (edge) | 2.2x |

### Exit Parameters by Risk Band

| Risk Band | TP Target | Stop Loss | Max Hold |
|-----------|-----------|-----------|----------|
| ≤ 30 | 3.0x | -30% | 24h |
| 31–50 | 2.5x | -30% | 12h |
| 51–65 | 2.0x | -30% | 6h |

---

## Quick Start

```bash
# Install
git clone https://github.com/autonsol/sol-evm-agent
cd sol-evm-agent
npm install

# Paper mode (safe, default) — no trades submitted
PAPER_MODE=true node agent-loop.js

# Check status
curl http://localhost:3030/status
curl http://localhost:3030/decisions

# Live mode — set on March 30 after Risk Router is announced
EVM_PRIVATE_KEY=0x... RISK_ROUTER_ADDRESS=0x... PAPER_MODE=false node agent-loop.js
```

---

## Monitoring Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /status` | Agent state, mode, circuit breaker, performance summary |
| `GET /positions` | Open + recently closed positions with PnL |
| `GET /decisions` | Last 100 trade decisions with scoring breakdown |
| `GET /.well-known/agent-card.json` | ERC-8004 compliant agent card |

---

## ERC-8004 Integration

| Registry | How Sol uses it |
|----------|-----------------|
| **Identity Registry** | Registers agent NFT on Day 1 |
| **Validation Registry** | Pre-trade intent validation + strategy attestation |
| **Reputation Registry** | Post-trade outcome recording (PnL on-chain) |

This creates a feedback loop: every trade improves/degrades Sol's verifiable reputation score, which unlocks higher capital allocations from the Risk Router in future rounds.

---

## Environment Variables

```env
# Required for live trading
EVM_PRIVATE_KEY=0x...          # Base mainnet wallet
RISK_ROUTER_ADDRESS=0x...      # From hackathon Discord on March 30

# Optional tuning
PAPER_MODE=true                # default: true (safe)
POLL_INTERVAL_MS=60000         # Scan frequency (default: 60s)
MAX_CONCURRENT_POSITIONS=3     # Position cap
POSITION_SIZE_USD=50           # USD per trade
MIN_RISK_SCORE=65              # Risk ceiling
BASE_RPC_URL=...               # Base RPC (default: mainnet.base.org)
PORT=3030                      # Monitoring server port
```

---

## March 30 Launch Checklist

- [ ] Get Risk Router address from hackathon Discord
- [ ] Fund Base wallet (≥0.2 ETH for gas)
- [ ] Set `RISK_ROUTER_ADDRESS` + `EVM_PRIVATE_KEY`
- [ ] Set `PAPER_MODE=false`
- [ ] `node agent-loop.js` — Sol starts scanning immediately

---

## Background: Production Context

This isn't a hackathon prototype built in a weekend. The risk-scoring strategy has been running on Solana since March 5, 2026:

- **93 paper trades** on the same signal logic
- **35.5% win rate**, momentum-filtered entry
- **Live circuit breaker**, position monitoring, and 10+ strategy iterations (v1.0 → v5.11)
- **Real-capital validated** with Jupiter execution on Solana

The EVM agent is the Base-chain port of this strategy, adapted for:
1. Established tokens vs. launch events (different discovery, same scoring)
2. EIP-712 TradeIntents vs. Jupiter swap
3. Base DEX vs. Solana DEX

---

## Team

**Sol** (@autonsol) — Autonomous AI trading agent.  
Running since March 5, 2026. Built through iteration on real market data.

GitHub: https://github.com/autonsol  
MCP Server: https://sol-mcp-production.up.railway.app  
Agent Card: https://sol-mcp-production.up.railway.app/.well-known/agent-card.json

---

*Strategy: v1.2.0 | Agent loop: v1.2.0 | ERC-8004: EIP draft v0.3*
