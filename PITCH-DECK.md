# Sol — ERC-8004 AI Trading Agent
### Pitch Deck — ERC-8004 × AI Trading Agents Hackathon (March 30 – April 12, 2026)

---

## Slide 1: Cover

**Sol ☀️**
*An Autonomous AI Trading Agent on Base Chain*

- **Live endpoint:** https://sol-evm-agent-production.up.railway.app
- **GitHub:** https://github.com/autonsol/sol-evm-agent
- **Hackathon:** ERC-8004 × AI Trading Agents | $60K Prize Pool

---

## Slide 2: The Problem

**AI agents can't trade without human intervention.**

Current state of AI trading:
- ❌ Agents need manual fund custody — a human still holds the keys
- ❌ No on-chain identity standard — agents can't prove reputation
- ❌ No agent-native payment rails — every call requires a human API key
- ❌ Trading strategies are static — no self-improvement loop

**ERC-8004 solves identity. Sol builds the autonomous intelligence layer on top.**

---

## Slide 3: What Sol Does

Sol is a fully autonomous trading agent running 24/7 on Base chain.

**Core loop (every 60 seconds):**
1. 🔍 **Discover** — scan Base chain tokens via DexScreener API
2. 📊 **Score** — evaluate momentum ratio, liquidity depth, 1h/5m price trend
3. ✍️ **Sign** — construct EIP-712 TradeIntent + submit to Risk Router contract
4. 📈 **Monitor** — track open positions every 20 seconds
5. 🧠 **Learn** — diagnose each exit, update strategy, redeploy

**No human in the loop. Sol runs, trades, learns, and iterates autonomously.**

---

## Slide 4: The Autonomous Learning Loop

Sol has completed **5 strategy phases** — each one diagnosing a failure and shipping a targeted fix.

| Phase | Version | Key Change | WR | PnL |
|-------|---------|-----------|-----|-----|
| **P1 Baseline** | Pre-v1.18 | Raw signal, no filters | **57.1%** | **+69.9%** |
| **P2 Stabilized** | v1.18–v1.24 | Liquidity floor $300K | 35.1% | -88.8% |
| **P3 Momentum** | v1.28–v1.30 | 3x momentum + $400K liq | 56.7% | -14.4% |
| **P4 Stall Fix** | v1.31–v1.33 | Weakened stall exit | — | (rapid iteration) |
| **P5 Symmetric** | v1.34–v1.40 | 10/10 TP/SL + trend confirm | 47.6% | -19.7% |

> **109 total paper trades across 6 days of live operation.** Every phase = a real diagnosis, not a tuning guess.

---

## Slide 5: ERC-8004 Integration

Sol is built around ERC-8004's agent identity standard.

**Agent Card** — `/.well-known/agent-card.json`
- Capability: `token-risk-signals.v1` — on-chain token scoring
- x402 micropayment auth — agent-to-agent data subscriptions ($0.01/call)
- Reputation attestations via ERC-8004 on-chain registry

**EIP-712 TradeIntents**
- Every trade decision produces a signed TradeIntent
- Intent structure: `tokenAddress`, `direction`, `riskScore`, `momentumRatio`, `liquidityUsd`, `agentId`, `timestamp`, `nonce`
- Designed for submission to ERC-8004 Risk Router contract

**ERC-8004 reputation feed** — trade history provenance on-chain so any consumer can verify Sol's edge without trusting a dashboard.

---

## Slide 6: Live Signal Quality

**Current strategy filter** (momentum ≥ 3x, liquidity ≥ $400K):

| Metric | Value |
|--------|-------|
| Qualifying trades | 57 of 109 (52.3%) |
| Win rate | **50.9%** |
| Best trade | +16.6% |
| Worst trade | -15.6% |
| Profit factor | 0.81 |

**Phase 5 best trade:** +12.3% JUNO (take_profit) — confirms 10% TP is reachable on Base chain established tokens.

**Retroactive simulation:** Applying Phase 5 params (10/10 TP/SL) to all 30 Phase 3 trades → improves total PnL from -14.4% to **-9.7%** (2 new take_profits unlocked, 3 SLs tightened by 5%).

---

## Slide 7: Why This Matters for ERC-8004

Sol demonstrates the full ERC-8004 value stack:

```
Agent Identity (ERC-8004)
        ↓
Verified Trade History (on-chain reputation)
        ↓
EIP-712 TradeIntents → Risk Router
        ↓
x402 Micropayments (agent-to-agent data access)
        ↓
Autonomous Capital Deployment
```

**Without ERC-8004:** An AI trading agent is a black box. No accountability, no verifiable edge, no trust primitives.

**With ERC-8004:** Sol's every decision is signed, every trade is provenance-linked, and any downstream agent can subscribe to its signals via x402 micropayments — no human API key required.

---

## Slide 8: Technical Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22 on Railway (24/7) |
| Chain | Base (Ethereum L2) |
| Data source | DexScreener API (60s scan) |
| Position monitoring | 20s interval (v1.38.0) |
| State persistence | PostgreSQL — survives Railway deploys |
| Agent identity | ERC-8004 agent card |
| Payment rails | x402 micropayments |
| Trade execution | EIP-712 TradeIntent → Risk Router |
| Shadow signals | /signals endpoint — shows signal quality even in blocked hours |

**Observability:** `/decisions` (every signal with reasoning), `/stats` (5-phase history), `/signals` (shadow buys during blocked hours)

---

## Slide 9: Roadmap (Hackathon → Beyond)

**Hackathon Phase (March 30 – April 12):**
- ✅ Phase 6 (1h trend confirmation filter) deployed at hackathon start
- 🔄 Risk Router integration — flip `PAPER_MODE=false`, set `RISK_ROUTER_ADDRESS`
- 📈 Live capital deployment on Base chain

**Post-Hackathon:**
- Deploy x402 signal subscription endpoint — any agent can buy Sol's signals for $0.01/call
- Expand to Solana: graduation event detection + on-chain TradeIntent bridge
- Submit reputation attestations to ERC-8004 registry after Risk Router goes live
- SAID Protocol integration for cross-chain agent identity verification

---

## Slide 10: Live Now

**Try it yourself:**

| Endpoint | What you see |
|----------|-------------|
| `/decisions` | Every token scored in real time, with full reasoning |
| `/stats` | 5-phase learning history (109 trades, 47.7% WR) |
| `/signals` | Shadow buy signals — quality evidence during blocked hours |
| `/.well-known/agent-card.json` | ERC-8004 agent identity |

**Base wallet:** Ready to receive gas for live Risk Router execution.

---

> *Sol has been running autonomously since March 24, 2026 — scanning tokens, making decisions, and self-improving without a human in the loop. This is what ERC-8004 enables: accountable, verifiable, autonomous agent capital.*

---

**Contact / Links:**
- Live: https://sol-evm-agent-production.up.railway.app
- GitHub: https://github.com/autonsol/sol-evm-agent
- X: @autonsol
- Telegram: @autonsol
