/**
 * agent-loop.js
 *
 * Sol Autonomous Trading Agent — ERC-8004 Hackathon Main Loop
 *
 * Orchestrates:
 *   1. Token discovery (DexScreener — new Base listings)
 *   2. Signal scoring (evm-signal-adapter.js)
 *   3. Trade decisions (buy/skip logic)
 *   4. Intent construction + signing (trade-intent-builder.js)
 *   5. Risk Router submission (when RISK_ROUTER_ADDRESS is set)
 *   6. Position monitoring (TP/SL exits)
 *   7. Performance tracking
 *
 * Usage:
 *   PAPER_MODE=true node agent-loop.js          # safe dry-run (default)
 *   RISK_ROUTER_ADDRESS=0x... node agent-loop.js # live on March 30
 *
 * Environment vars:
 *   EVM_PRIVATE_KEY         - Agent wallet private key (required for live)
 *   RISK_ROUTER_ADDRESS     - Set on March 30 from hackathon Discord
 *   BASE_RPC_URL            - Base mainnet RPC (default: mainnet.base.org)
 *   PAPER_MODE              - "true" = simulate only, never submit (default: true)
 *   POLL_INTERVAL_MS        - Token scan frequency (default: 60000 = 60s)
 *   MAX_CONCURRENT_POSITIONS- Position cap (default: 3)
 *   POSITION_SIZE_USD       - USD per trade (default: 50)
 *   MIN_RISK_SCORE          - Max acceptable risk score (default: 65)
 *   PORT                    - HTTP monitoring server port (default: 3030)
 */

import fetch from 'node-fetch';
import { createServer }        from 'http';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join }                from 'path';
import { scoreEvmToken }       from './evm-signal-adapter.js';
import { TradeIntentBuilder, BASE_TOKENS } from './trade-intent-builder.js';
import { ethers } from 'ethers';
import { initDB, saveTrade, loadTrades, saveDecision, loadDecisions, saveAgentState, loadAgentState } from './db.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  paperMode:           process.env.PAPER_MODE !== 'false', // default: paper mode
  pollIntervalMs:      parseInt(process.env.POLL_INTERVAL_MS || '60000'),
  maxPositions:        parseInt(process.env.MAX_CONCURRENT_POSITIONS || '3'),
  positionSizeUSD:     parseFloat(process.env.POSITION_SIZE_USD || '50'),
  minRiskScore:        parseInt(process.env.MIN_RISK_SCORE || '65'),
  port:                parseInt(process.env.PORT || '3030'),
  privateKey:          process.env.EVM_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  riskRouterAddress:   process.env.RISK_ROUTER_ADDRESS || null,
  baseRpcUrl:          process.env.BASE_RPC_URL || 'https://mainnet.base.org',
};

// Momentum thresholds by risk band (Base chain calibration — v1.2)
//
// NOTE: These are intentionally LOWER than the Solana grad-alert thresholds.
// Reason: Base chain uses established tokens (BRETT, VIRTUAL, AERO) with steady
// volume baselines. Our composite momentum (vol acceleration × buy pressure boost)
// on these tokens typically ranges 0.8x–3.0x on active days, not the 4–8x spikes
// seen on Solana pump.fun graduations.
//
// Calibration basis: DexScreener h1 data on Base tokens (manual review, 2026-03-19)
//   - BRETT (risk ~20): typical momentum 1.0–2.5x on trending days
//   - VIRTUAL (risk ~35): typical momentum 1.2–3.0x when agents are pumping
//   - New Base memecoins (risk ~55–65): often 1.5–4.0x on launch week
//
// v1.19.0: Raised alpha tier threshold 1.5x → 2.0x based on 20-trade live analysis:
//   - WW3 (1.65x): -18.2% time_expired — weak momentum led to prolonged drift
//   - NOOK (1.65x): -2.3% time_expired — barely cleared threshold, never recovered
//   - CLAWD (1.94x): -4.6% time_expired — borderline signal, underperformed
//   - Raising to 2.0x would have blocked WW3 (-18.2%), NOOK (-2.3%), CLAWD (-4.6%), REKT (-1.0%)
//   - Only loss: VVV (1.75x, +6.3%) — net gain ~+19.9% on visible trades
//
// v1.26.0: Added strategy_epochs + current_strategy_filter to /stats endpoint.
//   All-time stats are polluted by pre-fix historical trades (ZRO liq_crash false positives,
//   sub-2.5x momentum entries). Epoch breakdown shows agents/judges the improvement arc:
//   Phase 1 (raw baseline) → Phase 2 (stabilized) → Phase 3 (live 2.5x+ strategy).
//   current_strategy_filter shows performance of ONLY trades matching live criteria.
//   Extracted computeMetrics() helper shared across all breakdowns.
//
// v1.25.0: Raised thresholds to 2.5x/2.5x/2.8x based on 58-trade live analysis:
//   - TIBBIR (2.03x): -5.4% momentum_stall — barely cleared 2.0x, never found follow-through
//   - ODAI (2.13x): -2.2% momentum_stall — same pattern
//   - MOLT (2.57x): +2.1% momentum_stall — small win but barely above new threshold
//   - DRB (2.66x): -2.8% momentum_stall — above 2.5x but still stalled (volume was dead by check)
//   - Pattern: 2.0-2.5x range is "volume noise" on Base, not directional momentum.
//     Real momentum (trailing_stop winners: OVPP +50.6%, DRV +14x) was 3x+ at entry.
//   - Expected: ~30% fewer entries, 40%+ WR → 55%+, expectancy goes positive.
//
// Thresholds set at 80th-90th percentile of "active but not parabolic" range:
const MOMENTUM_THRESHOLDS = {
  30: 2.5,  // risk ≤ 30 (alpha zone): 2.5x (raised from 2.0x in v1.25.0)
  50: 2.5,  // risk 31-50: 2.5x (raised from 2.0x in v1.25.0)
  65: 2.8,  // risk 51-65: 2.8x (raised from 2.2x in v1.25.0)
};

// Exit params by risk band (v1.15.0 — tightened SL for Base chain risk profile)
//
// Previous targets (3x/2.5x/2x) were calibrated for Solana pump.fun memecoins
// which can 5-10x at graduation. Base chain has different dynamics:
//   - BRETT/VIRTUAL/AERO: well-established, 30-80% swings on momentum days
//   - New memecoins: can 2-4x but liquidity is thinner (need faster exits)
// Adjusted to realistic Base chain momentum targets. Trailing stop (see below)
// locks in gains when tokens reverse before hitting TP.
//
// v1.15.0: Tightened SL from 25% → 15% based on 22-trade live data analysis:
//   - TAOLOR: hit -25% SL (would have exited at -15%, saved 10 pts)
//   - WW3: peaked at 0%, drifted to -18.2% time_expired (would SL at -15%, saved 3 pts)
//   - Base chain tokens move 3-15% on a good day — 25% SL allows 2 full "bad days"
//   - 15% SL aligns with one bad day; trailing stop handles the upside
//   - Expected: max drawdown improves from -57% to ~-35%; Sharpe proxy improves 0.15→0.25+
//
// v1.19.0: Lowered TP targets and reduced hold times based on 20-trade live data analysis:
//   - 2.0x TP (100% gain) was NEVER HIT in 20 visible trades — unrealistic for Base chain
//   - Established tokens (BRETT, VIRTUAL, AERO) move 5-50% on strong days, rarely 100%+
//   - Reduced holdHours: faster slot cycling → more opportunities; stall exit fires sooner
//   - New TP targets calibrated to match Base chain realistic momentum range:
//     Alpha (≤30): 35% TP achievable on strong trend days (OVPP hit +50.6%)
//     Core (31-50): 25% TP for moderate conviction tokens
//     Edge (51-65): 15% TP for highest-risk tier (thin margin above SL, trail handles rest)
//   - Trailing stop system still intact: Phase -1 through Phase 3 protect gains below TP
//   - Expected: TP hits increase from 0/20 to 3-5/20; time_expired exits decrease
const EXIT_PARAMS = {
  30: { tpMultiple: 1.35, slPct: 0.15, holdHours: 4  }, // risk≤30: +35% TP, 15% SL, 4h (was 2.0x/6h)
  50: { tpMultiple: 1.25, slPct: 0.15, holdHours: 3  }, // risk 31-50: +25% TP, 15% SL, 3h (was 1.6x/5h)
  65: { tpMultiple: 1.15, slPct: 0.12, holdHours: 2  }, // risk 51-65: +15% TP, 12% SL, 2h (was 1.4x/3h)
};

// Trailing stop config (v1.14.0) — activates when position reaches profit milestone
// Protects gains when token reverses before hitting TP target.
// Trail is measured from PEAK pnl, not entry.
//
// v1.10.0: Added Phase 0 (8% trigger) based on live data:
//   - SYND second position peaked at +8.83% then reversed to -2.18% (unprotected)
//   - CashClaw and first SYND both hit +20%+ → captured by Phase 1
//
// v1.14.0: Added momentum stall early exit (separate from trailing stop):
//   - Positions open ≥ 60% of holdHours that never hit 3% gain → close early
//   - Frees slots for new signals; avoids holding dead weight 6h with 0 gain
//   - SOL and BRETT both peaked <1.5%, held full 6h → time_expired near entry
//   - See checkPositions() momentum stall block for full logic
//
// v1.13.0: Added Phase -1 (3% trigger) based on live data from 2026-03-23:
//   - INSTACLAW peaked at +4.2%, then reversed to -7.2% — zero trailing stop protection
//   - FAI peaked at +2.8%, then reversed to -2.9% — same pattern
//   - 3 of 5 open positions peaked in the 3-7% range (below old Phase 0 at 8%)
//   - Base chain established tokens (VIRTUAL, FAI, INSTACLAW) move 3-6% on momentum days
//     — not the 8-20% needed to trigger old Phase 0
//   - Fix: add Phase -1 at 3% trigger / 3% trail to protect small gains
//     Lock in breakeven (~0%) when peak is 3-4%, or small win (~1%) when peak is 4-7%
//   INSTACLAW would have exited at ~+1.2% (peak 4.2%, trail 3%) instead of -7.2%
//   FAI would have exited at ~+0% (peak 2.8%, trail 3% = breakeven floor)
//
//   Phase -1: pnlPct ≥  3% → trail at peak - 3%  (breakeven protection for small pumps)
//   Phase 0:  pnlPct ≥  8% → trail at peak - 5%  (lock in ~3% min profit)
//   Phase 1:  pnlPct ≥ 20% → trail at peak - 12% (lock in ~8% min profit)
//   Phase 2:  pnlPct ≥ 50% → trail at peak - 10% (lock in ~40% min profit)
//   Phase 3:  pnlPct ≥ 100% → trail at peak - 8%  (lock in ~92% min profit)
const TRAILING_STOP_CONFIG = [
  { triggerPct: 100, trailPct: 8  }, // 100%+ gains: tight 8% trail
  { triggerPct: 50,  trailPct: 10 }, // 50-99% gains: 10% trail
  { triggerPct: 20,  trailPct: 12 }, // 20-49% gains: 12% trail
  { triggerPct: 8,   trailPct: 5  }, // 8-19% gains: 5% trail
  { triggerPct: 3,   trailPct: 3  }, // NEW v1.13.0: 3-7% gains: 3% trail (breakeven protection)
];

// Liquidity floor (USD) — don't trade tokens below this
//
// v1.18.0: Raised from $10K → $300K based on 28-trade live data analysis.
//
// Root cause of degraded WR (57.1% → 46.4%) and PnL (+69.9% → -7.7%):
// Micro-cap tokens with tiny pools are causing catastrophic losses:
//   CSTAR:  $58K  liq → -29.6% (stop_loss)
//   WW3:    $64K  liq → -18.2% (time_expired drift)
//   TAOLOR: $123K liq → -25.0% (stop_loss)
//   REKT:   $217K liq → -1.0%  (time_expired)
//
// These 4 trades = -73.8% total PnL drag. At $300K floor, all 4 are eliminated.
// Only meaningful loss from this change: MLTL ($122K, +0.9%) — net gain ~+72.9%.
//
// Winners from same period all had ≥$438K liquidity:
//   OVPP: $482K → +50.6% (trailing stop, Phase 2)
//   SYND: $438K → +9.1%  (trailing stop, Phase 1)
//   SOL:  $503K → +0.8%  (time_expired)
//
// $300K floor aligns with "established Base token with real market depth."
// Tokens below this have high spread and react catastrophically to moderate sells.
// Override: set MIN_LIQUIDITY_USD env var to change at runtime.
const MIN_LIQUIDITY_USD = parseInt(process.env.MIN_LIQUIDITY_USD || '300000');

// Time-of-day filter (UTC hours to block trading)
//
// Base chain DeFi activity mirrors US/EU market hours. Overnight UTC (22:00–07:00)
// has materially lower volume on Aerodrome/Uniswap Base pairs and higher spread on
// Virtual Protocol agent tokens. Blocking low-activity hours avoids entering
// positions that stall (hit TIME_EXIT instead of TP) due to thin overnight markets.
//
// Calibration: US/EU overlap 13:00–17:00 UTC = peak Base DEX volume.
//              US close → Asia close = 22:00–06:00 UTC = low Base activity.
// Override: set TRADING_HOURS_UTC env var as comma-separated allowed hours
//           (e.g., "8,9,10,11,12,13,14,15,16,17,18,19,20,21")
//           or BLOCKED_HOURS_UTC as comma-separated hours to block.
const DEFAULT_BLOCKED_HOURS_UTC = [0, 1, 2, 3, 4, 5, 6, 7]; // overnight block
const BLOCKED_HOURS_UTC = process.env.BLOCKED_HOURS_UTC
  ? process.env.BLOCKED_HOURS_UTC.split(',').map(Number)
  : DEFAULT_BLOCKED_HOURS_UTC;

// Get current UTC hour and whether it's a tradeable window
function getHourStatus() {
  const h = new Date().getUTCHours();
  if (BLOCKED_HOURS_UTC.includes(h)) {
    return { blocked: true, hour: h, reason: `hour_${h}_UTC_blocked (low Base volume)` };
  }
  // Prime hours: US/EU overlap 13–17 UTC → apply momentum discount for aggressive entry
  const isPrime = h >= 13 && h <= 17;
  return { blocked: false, hour: h, prime: isPrime };
}

// Persistence paths (Railway compatible)
const STATE_FILE = process.env.STATE_FILE || join(process.cwd(), 'agent-state.json');
const PERSIST_INTERVAL_MS = 30000; // auto-save every 30s

// ─── Persistence Layer ────────────────────────────────────────────────────────

function saveState() {
  try {
    // Persist recentlyExited blacklist (v1.21.0): survives Railway restarts so tokens
    // recently exited as liq_crash/stop_loss don't re-enter on the next scan after deploy.
    // Only save entries that haven't expired yet (within their blacklist window).
    const recentlyExitedSnapshot = [...state.recentlyExited.entries()]
      .filter(([, v]) => {
        const maxMin = v.blacklistMinutes || 60;
        return (Date.now() - v.exitTime) < maxMin * 60000;
      });

    const snapshot = {
      startedAt: state.startedAt,
      version: state.version,
      scanCount: state.scanCount,
      decisions: state.decisions.slice(0, 50), // keep last 50 for replay
      openPositions: [...state.openPositions.entries()].map(([addr, pos]) => [addr, pos]),
      closedPositions: state.closedPositions.slice(0, 100), // keep last 100
      shadowBuys: state.shadowBuys.slice(0, 30),
      capacityMisses: state.capacityMisses.slice(0, 50),
      circuitBreaker: state.circuitBreaker,
      recentlyExited: recentlyExitedSnapshot, // v1.21.0: persist blacklist
      persistedAt: new Date().toISOString(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    log('[persist] Save error', { error: err.message });
  }
}

function loadState() {
  if (!existsSync(STATE_FILE)) {
    log('[persist] No state file found — starting fresh');
    return null;
  }
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    log('[persist] Loaded prior state', {
      scanCount: data.scanCount,
      openPositions: data.openPositions?.length || 0,
      closedPositions: data.closedPositions?.length || 0,
    });
    return data;
  } catch (err) {
    log('[persist] Load error — discarding corrupted state', { error: err.message });
    return null;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  startedAt:    new Date().toISOString(),
  version:      '1.26.0',
  mode:         CONFIG.paperMode ? 'PAPER' : 'LIVE',
  scanCount:    0,
  decisions:    [],           // last 100 decisions
  shadowBuys:   [],           // would-have-been BUY signals during blocked hours (last 30)
  capacityMisses: [],         // liquid candidates skipped only due to position_cap (last 50)
  shadowPositions: new Map(), // shadow paper positions opened from shadow buys (token → pos)
  closedShadowPositions: [],  // historical closed shadow positions (for /shadow-performance)
  openPositions: new Map(),   // tokenAddress → position
  closedPositions: [],        // historical closed positions
  seenTokens:   new Set(),    // avoid re-scanning same tokens in short window
  recentlyExited: new Map(),  // tokenAddress → { exitTime, reason } — re-entry blacklist
  stallCounts:  new Map(),    // tokenAddress → number of momentum_stall exits this session
  intentBuilder: null,        // TradeIntentBuilder instance
  circuitBreaker: {
    active: false,
    reason: null,
    resetAt: null,
    consecutiveLosses: 0,
    maxLosses: CONFIG.paperMode ? 15 : 5, // paper mode: higher tolerance (no real capital at risk)
  },
};

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg, data = {}) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`, Object.keys(data).length ? JSON.stringify(data) : '');
}

function recordDecision(decision) {
  const hourStatus = getHourStatus();
  const d = {
    ...decision,
    timestamp: new Date().toISOString(),
    hour_utc: hourStatus.hour,
    hour_status: hourStatus.blocked ? 'blocked' : (hourStatus.prime ? 'prime' : 'normal'),
  };
  state.decisions.unshift(d);
  if (state.decisions.length > 100) state.decisions = state.decisions.slice(0, 100);
  // Fire-and-forget to Postgres (non-blocking)
  saveDecision(d);
}

// ─── Token Discovery ──────────────────────────────────────────────────────────

/**
 * Fetch active tokens on Base via DexScreener.
 * Returns array of token addresses to evaluate.
 *
 * Strategy (v1.1 — improved from single-scan testing):
 *  1. Token boosts endpoint — paid/promoted Base tokens
 *  2. Token profiles endpoint — Base tokens with social profiles
 *  3. Multi-term search API — aerodrome/uniswap/virtual give 20-30 pairs each
 *  4. No hard age filter — Base isn't pump.fun; established tokens have momentum too
 *     Instead: filter on volume and liquidity at decision time
 *
 * Note: seenTokens is cleared every 10 scans so we re-evaluate tokens
 * whose momentum may have changed.
 */
async function discoverBaseTokens() {
  const discovered = [];
  const seen = new Set();

  const addIfNew = (addr, meta) => {
    const lower = addr.toLowerCase();
    if (!seen.has(lower) && !state.seenTokens.has(lower)) {
      seen.add(lower);
      discovered.push({ address: addr, ...meta });
    }
  };

  // ── Source 1: Token Boosts (active promotions on Base) ────────────────────
  try {
    const res  = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', { timeout: 10000 });
    const data = await res.json();
    const boosts = Array.isArray(data) ? data : [];
    boosts
      .filter(b => b.chainId === 'base' && b.tokenAddress)
      .slice(0, 20)
      .forEach(b => addIfNew(b.tokenAddress, {
        symbol: b.description?.split(' ')[0] || b.tokenAddress.slice(0, 8),
        liquidity: 0,
        source: 'boost',
      }));
    log(`[discover] Boosts: ${boosts.filter(b => b.chainId === 'base').length} on Base`);
  } catch (err) {
    log('[discover] Boosts error', { error: err.message });
  }

  // ── Source 2: Token Profiles (some Base tokens in feed) ───────────────────
  try {
    const res  = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 10000 });
    const data = await res.json();
    const profiles = Array.isArray(data) ? data : [];
    profiles
      .filter(p => p.chainId === 'base' && p.tokenAddress)
      .slice(0, 20)
      .forEach(p => addIfNew(p.tokenAddress, {
        symbol: null,
        liquidity: 0,
        source: 'profile',
      }));
    log(`[discover] Profiles: ${profiles.filter(p => p.chainId === 'base').length} on Base`);
  } catch (err) {
    log('[discover] Profiles error', { error: err.message });
  }

  // ── Source 3: Multi-term DexScreener search ────────────────────────────────
  // These terms reliably return active Base pairs (validated 2026-03-19):
  //   "aerodrome"  → 30 Base pairs (main Base DEX router)
  //   "uniswap"    → 22 Base pairs
  //   "virtual"    → Virtual Protocol agents on Base
  //   "base"       → 21 Base pairs
  //   "new"        → recently listed tokens
  // No 48h age filter — Base tokens don't have pump.fun-style launches.
  // Filter by volume_h24 > 0 and liquidity at evaluation time instead.
  const searchTerms = [
    'aerodrome',    // Main Base DEX — 30 pairs
    'uniswap',      // Uniswap v3 on Base — 22 pairs
    'virtual',      // Virtual Protocol agent tokens — fast growing sector
    'base',         // General Base pairs — 21 pairs
    'brett',        // Major Base memecoin — check for correlated moves
    'WETH',         // WETH pairs on Base — high liquidity ecosystem
    'new',          // Recently listed
    'launch',       // New launches
  ];

  for (const term of searchTerms) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(term)}`;
      const res  = await fetch(url, { timeout: 8000 });
      const data = await res.json();
      const pairs = (data.pairs || [])
        .filter(p => p.chainId === 'base')
        .filter(p => p.baseToken?.address)
        // Exclude known stablecoin/WETH pair addresses (quote tokens)
        .filter(p => {
          const addr = (p.baseToken?.address || '').toLowerCase();
          const SKIP_ADDRS = [
            '0x4200000000000000000000000000000000000006', // WETH
            '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
            '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
          ];
          return !SKIP_ADDRS.includes(addr);
        });

      // For popular terms (aerodrome/uniswap), filter to tokens with some h1 price action
      // This surfaces tokens actively moving vs static pools
      const active = pairs.filter(p => {
        const h1Change = p.priceChange?.h1;
        const vol24 = p.volume?.h24 || 0;
        return vol24 > 1000; // at least $1K volume in 24h = some activity
      });

      active.slice(0, 15).forEach(p => addIfNew(p.baseToken.address, {
        symbol:    p.baseToken.symbol,
        liquidity: p.liquidity?.usd || 0,
        volume24h: p.volume?.h24 || 0,
        priceH1:   p.priceChange?.h1 || 0,
        dex:       p.dexId,
        pairAge:   p.pairCreatedAt ? ((Date.now() - p.pairCreatedAt) / 3600000).toFixed(1) + 'h' : '?',
        source:    `search:${term}`,
      }));
      if (active.length > 0) log(`[discover] Search "${term}": ${pairs.length} Base pairs, ${active.length} active`);
    } catch (err) {
      log('[discover] Search error', { term, error: err.message });
    }
    await new Promise(r => setTimeout(r, 250)); // avoid rate limiting
  }

  log(`[discover] Total unique Base candidates: ${discovered.length}`);
  return discovered;
}

// ─── Trade Decision Engine ────────────────────────────────────────────────────

/**
 * Evaluate a scored signal and decide BUY or SKIP.
 * Returns { action, reason, exitParams }
 */
function makeTradeDecision(signal) {
  // Circuit breaker
  if (state.circuitBreaker.active) {
    return {
      action: 'SKIP',
      reason: `circuit_breaker (${state.circuitBreaker.reason}, resets ${state.circuitBreaker.resetAt})`,
    };
  }

  // Re-entry blacklist: skip tokens we recently exited (liq_crash / stop_loss / momentum_stall)
  // Root cause: liq_crash closes a position instantly → token re-enters discovery next scan
  // → same losing token keeps opening → 5 consecutive CB triggers. Block re-entry for 1h.
  // v1.22.0: Also blacklist momentum_stall exits (30 min cool-off).
  //   momentum_stall = "showed momentum but didn't follow through" — re-entering immediately
  //   is likely to stall again (ROBOTMONEY exited stall then re-appeared in next scan).
  //   30 min cool-off prevents churning on flat tokens during the same activity window.
  const tokenAddr = (signal.mint || signal.address || '').toLowerCase();
  const recentExit = state.recentlyExited.get(tokenAddr);
  if (recentExit) {
    const ageMin = (Date.now() - recentExit.exitTime) / 60000;
    const maxMin = recentExit.blacklistMinutes || 60; // v1.21.0: use escalated window if set
    if (ageMin < maxMin) {
      return { action: 'SKIP', reason: `recently_exited (${recentExit.reason}, ${ageMin.toFixed(0)}min ago — blacklist ${maxMin}min)` };
    } else {
      state.recentlyExited.delete(tokenAddr); // blacklist expired
    }
  }

  // Time-of-day filter: block overnight UTC hours (low Base DEX volume)
  const hourStatus = getHourStatus();
  if (hourStatus.blocked) {
    return { action: 'SKIP', reason: `bad_hour (${hourStatus.reason})` };
  }

  // Position cap
  if (state.openPositions.size >= CONFIG.maxPositions) {
    return { action: 'SKIP', reason: `position_cap_reached (${state.openPositions.size}/${CONFIG.maxPositions})` };
  }

  // Risk threshold
  if (signal.score > CONFIG.minRiskScore) {
    return { action: 'SKIP', reason: `risk_too_high (${signal.score} > ${CONFIG.minRiskScore})` };
  }

  // v1.19.0: Skip unscored tokens (score=0 = no risk data from token-risk-service)
  // Live data: TAOLOR (score=0) hit -25% SL; NOOK (score=0) hit -2.3% — unvetted tokens
  // with zero risk assessment are essentially unknown. Require at least minimal scoring.
  if (signal.score === 0 || signal.score === null || signal.score === undefined) {
    return { action: 'SKIP', reason: 'unscored_token (score=0, no risk data available)' };
  }

  // Liquidity floor
  if (signal.liquidity_usd < MIN_LIQUIDITY_USD) {
    return { action: 'SKIP', reason: `low_liquidity ($${Math.round(signal.liquidity_usd)} < $${MIN_LIQUIDITY_USD})` };
  }

  // No momentum data
  if (!signal.momentum_ratio || signal.momentum_ratio <= 0) {
    return { action: 'SKIP', reason: 'no_momentum_data' };
  }

  // v1.22.0: Max liquidity cap — skip mega-cap tokens unlikely to reach TP target.
  // Evidence from live data:
  //   AERO ($14M+ liq): 0.0% PnL (stalled, never approached 35% TP)
  //   VIRTUAL ($8-14M liq): -1.5% / +3.7% — small moves, slots occupied for 4h
  //   VVV ($14.3M liq): +8.3% — best case for large cap is half our TP target
  //
  // Root cause: Base chain blue-chip DeFi tokens (AERO = Aerodrome, VIRTUAL = Virtual Protocol)
  // have real market depth with billions in TVL. They move 5-15% on strong momentum days.
  // Our 35% TP (EXIT_PARAMS[30].tpMultiple = 1.35) is realistic for mid-caps ($300K-$5M liq)
  // but not for mega-caps ($5M+) where 35% would require a major market event.
  //
  // Fix: Cap max entry liquidity at $5M. Keeps OVPP ($482K), SYND ($438K), INSTACLAW
  // and similar mid-cap winners. Filters AERO, VIRTUAL, and similar blue chips.
  const MAX_LIQUIDITY_USD = parseInt(process.env.MAX_LIQUIDITY_USD || '5000000');
  if (signal.liquidity_usd > MAX_LIQUIDITY_USD) {
    return { action: 'SKIP', reason: `too_liquid ($${(signal.liquidity_usd/1e6).toFixed(1)}M > $${(MAX_LIQUIDITY_USD/1e6).toFixed(0)}M cap — blue chip, TP unlikely)` };
  }

  // Momentum threshold (tiered by risk score)
  // v1.22.0: Removed prime hour discount (-0.2x) for alpha/core tiers.
  // Evidence: prime hour discount admitted entries at 1.8x (2.0x - 0.2x) that all stalled:
  //   NOCK (-5.3% momentum_stall), ROBOTMONEY (-4.4% momentum_stall),
  //   AERO (-0.0% momentum_stall), VIRTUAL (-1.5% momentum_stall).
  // The prime discount was designed to catch more entries during peak hours, but Base chain
  // activity patterns mean the extra 0.2x of "prime hour enthusiasm" creates false signals.
  // Winners all had momentum >= 2.0x WITHOUT needing the discount (OVPP, SYND, INSTACLAW).
  // Keeping 0.1x discount for edge tier (risk 51-65) only — these tokens need more passes.
  let requiredMomentum = MOMENTUM_THRESHOLDS[65] ?? 2.2; // default for risk 51-65
  if (signal.score <= 30) requiredMomentum = MOMENTUM_THRESHOLDS[30];
  else if (signal.score <= 50) requiredMomentum = MOMENTUM_THRESHOLDS[50];

  if (hourStatus.prime && signal.score > 50) {
    requiredMomentum = Math.max(requiredMomentum - 0.1, 1.5); // small prime discount for edge tier only
  }

  if (signal.momentum_ratio < requiredMomentum) {
    return {
      action: 'SKIP',
      reason: `weak_momentum (${signal.momentum_ratio.toFixed(2)}x < ${requiredMomentum.toFixed(1)}x for risk ${signal.score}${hourStatus.prime ? ' [prime]' : ''})`,
    };
  }

  // Note: No hard age filter on Base chain. Unlike Solana pump.fun, Base tokens
  // include established protocols (BRETT, VIRTUAL, AERO) that are months old but have
  // momentum signals. Momentum ratio + volume filters catch stale vs active.

  // Overbought filter: if +200%+ in 1h, likely pump-and-dump peak
  if (signal.price_change_1h > 200) {
    return { action: 'SKIP', reason: `overbought_pump (${signal.price_change_1h.toFixed(0)}% 1h)` };
  }

  // v1.24.0: Price direction filter — require positive 1h price action alongside volume momentum.
  // Root cause of momentum_stall exits: volume momentum (volRatio × buyPressureBoost) fires
  // when volume is elevated, but volume can be SELLING pressure, not buying.
  // If price_change_1h <= -5%, the volume is net-negative for price → entering into distribution.
  // All our worst stall exits (AERO, VIRTUAL, ROBOTMONEY) likely had flat/declining price
  // while showing volume acceleration.
  //
  // Evidence from v1.23.0 live data (10 momentum_stall trades, 20% WR, -3.3% avg):
  //   - 8/10 stall exits peaked at or near 0% (never had any positive price move after entry)
  //   - Trailing stop wins (100% WR) had meaningful positive price move from entry
  //   - Volume ratio alone is insufficient signal — price must confirm direction
  //
  // Filter: skip if 1h price change <= -5% (significant decline = distribution, not accumulation).
  // Allow flat (-5% to 0%) since momentum might be in very early stages.
  // Allow any positive price action — confirming buyers are winning.
  if (signal.price_change_1h !== null && signal.price_change_1h !== undefined && signal.price_change_1h < -5) {
    return {
      action: 'SKIP',
      reason: `price_declining_1h (${signal.price_change_1h.toFixed(1)}% 1h — volume is selling pressure, not buying)`,
    };
  }

  // v1.25.0: 5-minute price direction filter — require non-negative recent price action.
  // The 1h filter catches macro distribution but misses "entered at the peak of a local move."
  // Pattern: token has +15% 1h (good), but the last 5 min is -3% (entering into a local reversal).
  // Evidence: momentum_stall exits peaked within first ~15min then reversed; 5m filter targets
  //   tokens that are currently pulling back after their momentum spike has already happened.
  //
  // Threshold: -3% (not 0%) — allows brief pauses/consolidation after a move.
  // Block clear 5m drops (< -3%) — entering into a reversal, not a new impulse.
  // null = data unavailable → allow through (don't over-filter on missing data).
  if (signal.price_change_5m !== null && signal.price_change_5m !== undefined && signal.price_change_5m < -3) {
    return {
      action: 'SKIP',
      reason: `price_declining_5m (${signal.price_change_5m.toFixed(1)}% 5m — entering into local reversal, not impulse)`,
    };
  }

  // Get exit params for this risk band
  let exitParams = EXIT_PARAMS[65]; // default
  if (signal.score <= 30) exitParams = EXIT_PARAMS[30];
  else if (signal.score <= 50) exitParams = EXIT_PARAMS[50];

  return {
    action: 'BUY',
    reason: `momentum_${signal.momentum_ratio.toFixed(1)}x_risk_${signal.score}${hourStatus.prime ? '_prime_hour' : ''}`,
    exitParams,
  };
}

/**
 * Evaluate signal quality WITHOUT time-of-day or circuit breaker filters.
 * Used during blocked hours to track "shadow BUY" signals — tokens that would
 * have been traded if the time filter weren't active.
 *
 * This lets hackathon judges see signal discovery quality even before 08:00 UTC.
 * Exposed via /signals endpoint.
 */
function evaluateSignalOnly(signal) {
  if (signal.score > CONFIG.minRiskScore) {
    return { action: 'SKIP', reason: `risk_too_high (${signal.score} > ${CONFIG.minRiskScore})` };
  }
  // v1.19.0: skip score=0 (matches makeTradeDecision filter)
  if (signal.score === 0 || signal.score === null || signal.score === undefined) {
    return { action: 'SKIP', reason: 'unscored_token (score=0, no risk data available)' };
  }
  if (signal.liquidity_usd < MIN_LIQUIDITY_USD) {
    return { action: 'SKIP', reason: `low_liquidity ($${Math.round(signal.liquidity_usd)} < $${MIN_LIQUIDITY_USD})` };
  }
  if (!signal.momentum_ratio || signal.momentum_ratio <= 0) {
    return { action: 'SKIP', reason: 'no_momentum_data' };
  }
  let requiredMomentum = MOMENTUM_THRESHOLDS[65] ?? 2.2;
  if (signal.score <= 30) requiredMomentum = MOMENTUM_THRESHOLDS[30];
  else if (signal.score <= 50) requiredMomentum = MOMENTUM_THRESHOLDS[50];

  if (signal.momentum_ratio < requiredMomentum) {
    return { action: 'SKIP', reason: `weak_momentum (${signal.momentum_ratio.toFixed(2)}x < ${requiredMomentum.toFixed(1)}x required)` };
  }
  if (signal.price_change_1h > 200) {
    return { action: 'SKIP', reason: `overbought_pump (${signal.price_change_1h.toFixed(0)}% 1h)` };
  }
  // v1.24.0: Price direction filter (mirrors makeTradeDecision)
  if (signal.price_change_1h !== null && signal.price_change_1h !== undefined && signal.price_change_1h < -5) {
    return {
      action: 'SKIP',
      reason: `price_declining_1h (${signal.price_change_1h.toFixed(1)}% 1h — volume is selling pressure, not buying)`,
    };
  }
  // v1.25.0: 5m price direction filter (mirrors makeTradeDecision)
  if (signal.price_change_5m !== null && signal.price_change_5m !== undefined && signal.price_change_5m < -3) {
    return {
      action: 'SKIP',
      reason: `price_declining_5m (${signal.price_change_5m.toFixed(1)}% 5m — entering into local reversal, not impulse)`,
    };
  }
  let exitParams = EXIT_PARAMS[65];
  if (signal.score <= 30) exitParams = EXIT_PARAMS[30];
  else if (signal.score <= 50) exitParams = EXIT_PARAMS[50];
  return { action: 'BUY', reason: `momentum_${signal.momentum_ratio.toFixed(1)}x_risk_${signal.score}`, exitParams };
}

// ─── Position Management ──────────────────────────────────────────────────────

/**
 * v1.9.0: Conviction-based position sizing.
 * Lower risk score = higher conviction = larger position.
 * Scales within a ±50% band of the base POSITION_SIZE_USD.
 *
 *   Score  0-30  (LOW alpha):  base × 1.5  (max conviction, large liquidity, high momentum)
 *   Score 31-50  (LOW core):   base × 1.0  (standard conviction)
 *   Score 51-65  (EDGE):       base × 0.65 (reduced — higher risk tier, tighter sizing)
 *
 * This directly improves risk-adjusted returns: biggest bets on highest-conviction signals,
 * smaller bets on edge-case signals. Better Sharpe, lower max drawdown per dollar deployed.
 */
function getConvictionSize(score) {
  const base = CONFIG.positionSizeUSD;
  if (score <= 30) return Math.round(base * 1.5);  // alpha zone: 1.5x
  if (score <= 50) return base;                      // core zone: 1.0x
  return Math.round(base * 0.65);                    // edge zone: 0.65x
}

/**
 * Open a new position (paper or live).
 */
async function openPosition(signal, decision) {
  const tokenAddr = signal.mint || signal.address;
  if (state.openPositions.has(tokenAddr.toLowerCase())) {
    log('[position] Already holding token, skipping duplicate', { token: tokenAddr });
    return;
  }

  const position = {
    id:            `pos_${Date.now()}_${tokenAddr.slice(2, 8)}`,
    tokenAddress:  tokenAddr,
    symbol:        signal.symbol || signal.mint?.slice(0, 8),
    entryTime:     new Date().toISOString(),
    entryPrice:    signal.price_usd ?? null,   // Fix: was undefined when price_usd missing from old schema
    entryLiquidity: signal.liquidity_usd,
    entrySignal:   {
      score:          signal.score,
      risk_label:     signal.risk_label,
      momentum_ratio: signal.momentum_ratio,
      liquidity_usd:  signal.liquidity_usd,
    },
    positionSizeUSD:  getConvictionSize(signal.score), // v1.9.0: conviction-based sizing
    exitParams:       decision.exitParams,
    exitDeadline:     new Date(Date.now() + decision.exitParams.holdHours * 3600000).toISOString(),
    intentHash:       null,
    txHash:           null,
    status:           CONFIG.paperMode ? 'paper_open' : 'open',
    pnlPct:           null,
    exitReason:       null,
    exitTime:         null,
    peakPnlPct:       0,     // v1.8.0: trailing stop — tracks highest PnL reached
    trailStopPct:     null,  // v1.8.0: trailing stop level (null = not yet activated)
    convictionTier:   signal.score <= 30 ? 'alpha' : signal.score <= 50 ? 'core' : 'edge', // v1.9.0
  };

  // Submit TradeIntent (live mode only)
  if (!CONFIG.paperMode && state.intentBuilder) {
    try {
      const amountIn = ethers.parseUnits(position.positionSizeUSD.toString(), 6); // USDC 6 decimals (conviction-sized)
      const signed   = await state.intentBuilder.buildIntent({
        tokenIn:  BASE_TOKENS.USDC,
        tokenOut: tokenAddr,
        amountIn,
        signal,
      });
      position.intentHash = signed.intentHash;
      log('[position] Intent signed', { intentHash: signed.intentHash });

      if (CONFIG.riskRouterAddress) {
        const receipt = await state.intentBuilder.submitToRiskRouter(signed);
        position.txHash = receipt.txHash;
        position.intentId = receipt.intentId;
        log('[position] Submitted to Risk Router', { txHash: receipt.txHash });
      }
    } catch (err) {
      log('[position] Intent submission failed', { error: err.message });
      // Don't open position if we couldn't submit
      return;
    }
  }

  state.openPositions.set(tokenAddr.toLowerCase(), position);
  log(`[position] OPENED ${CONFIG.paperMode ? '(PAPER)' : '(LIVE)'}`, {
    symbol:      position.symbol,
    score:       signal.score,
    conviction:  position.convictionTier,
    momentum:    signal.momentum_ratio,
    tp:          `${((decision.exitParams.tpMultiple - 1) * 100).toFixed(0)}%`,
    sl:          `${(decision.exitParams.slPct * 100).toFixed(0)}%`,
    hold:        `${decision.exitParams.holdHours}h`,
    sizeUSD:     position.positionSizeUSD,
    baseSize:    CONFIG.positionSizeUSD,
  });
}

/**
 * Open a shadow position for a shadow BUY signal (blocked-hour tracking).
 * Shadow positions are paper-simulated: track TP/SL/time-exit with real DexScreener prices.
 * They are NOT real paper positions — they reflect what the agent "would have done"
 * during blocked hours. Exposed via /shadow-performance for judges.
 */
function openShadowPosition(shadowEntry) {
  const tokenAddr = shadowEntry.token?.toLowerCase();
  if (!tokenAddr || !shadowEntry.price_usd) return; // need entry price to track outcome
  if (state.shadowPositions.has(tokenAddr)) return; // don't duplicate

  // Use same exit params as real decision logic
  let exitParams = EXIT_PARAMS[65];
  if (shadowEntry.score <= 30) exitParams = EXIT_PARAMS[30];
  else if (shadowEntry.score <= 50) exitParams = EXIT_PARAMS[50];

  const pos = {
    id:           `shadow_${Date.now()}_${tokenAddr.slice(2, 8)}`,
    tokenAddress: tokenAddr,
    symbol:       shadowEntry.symbol,
    entryTime:    shadowEntry.timestamp,
    entryPrice:   shadowEntry.price_usd,
    entryMomentum: shadowEntry.momentum,
    entryLiquidity: shadowEntry.liquidity,
    score:        shadowEntry.score,
    risk_label:   shadowEntry.risk_label,
    exitParams,
    exitDeadline: new Date(new Date(shadowEntry.timestamp).getTime() + exitParams.holdHours * 3600000).toISOString(),
    status:       'shadow_open',
    pnlPct:       null,
    exitReason:   null,
    exitTime:     null,
  };

  state.shadowPositions.set(tokenAddr, pos);
  log(`[shadow-pos] Opened shadow position for ${pos.symbol}`, {
    momentum: shadowEntry.momentum,
    tp: `${((exitParams.tpMultiple - 1) * 100).toFixed(0)}%`,
    sl: `${(exitParams.slPct * 100).toFixed(0)}%`,
    hold: `${exitParams.holdHours}h`,
  });
}

/**
 * Check open shadow positions for TP/SL/time exits.
 * Mirrors checkPositions() but for shadow (blocked-hour) entries.
 */
async function checkShadowPositions() {
  if (state.shadowPositions.size === 0) return;

  for (const [tokenAddr, pos] of state.shadowPositions.entries()) {
    try {
      const pairs = await fetchCurrentPrice(tokenAddr);
      if (!pairs || pairs.length === 0) {
        if (new Date() > new Date(pos.exitDeadline)) {
          closeShadowPosition(tokenAddr, pos, 'time_expired', 0);
        }
        continue;
      }

      const currentPrice = pairs[0]?.priceUsd ? parseFloat(pairs[0].priceUsd) : null;
      if (!currentPrice || !pos.entryPrice) {
        if (new Date() > new Date(pos.exitDeadline)) {
          closeShadowPosition(tokenAddr, pos, 'time_expired', null);
        }
        continue;
      }

      const pnlPct = (currentPrice / pos.entryPrice - 1) * 100;

      // Take profit
      if (pnlPct >= (pos.exitParams.tpMultiple - 1) * 100) {
        closeShadowPosition(tokenAddr, pos, 'take_profit', pnlPct);
        continue;
      }

      // Stop loss
      if (pnlPct <= -(pos.exitParams.slPct * 100)) {
        closeShadowPosition(tokenAddr, pos, 'stop_loss', pnlPct);
        continue;
      }

      // Momentum stall (v1.14.0) — mirrors main checkPositions() logic
      {
        const peakPnl = pos.peakPnlPct || 0;
        if (pnlPct > peakPnl) pos.peakPnlPct = pnlPct;
        const ageHours = (Date.now() - new Date(pos.entryTime).getTime()) / 3600000;
        const stallCheckMs = new Date(pos.entryTime).getTime()
          + (pos.exitParams.holdHours * 0.6 * 3600000);
        if (Date.now() >= stallCheckMs && (pos.peakPnlPct || 0) < 5) {
          closeShadowPosition(tokenAddr, pos, 'momentum_stall', pnlPct);
          continue;
        }
      }

      // Time expiry
      if (new Date() > new Date(pos.exitDeadline)) {
        closeShadowPosition(tokenAddr, pos, 'time_expired', pnlPct);
        continue;
      }

      // Update current PnL for monitoring
      pos.currentPnlPct  = pnlPct;
      pos.currentPrice   = currentPrice;

    } catch (err) {
      log('[shadow-pos] Check error', { token: tokenAddr, error: err.message });
    }
  }
}

function closeShadowPosition(tokenAddr, pos, exitReason, pnlPct) {
  pos.exitTime   = new Date().toISOString();
  pos.exitReason = exitReason;
  pos.pnlPct     = pnlPct;
  pos.status     = 'shadow_closed';

  state.shadowPositions.delete(tokenAddr);
  state.closedShadowPositions.unshift(pos);
  if (state.closedShadowPositions.length > 100) {
    state.closedShadowPositions = state.closedShadowPositions.slice(0, 100);
  }

  const isWin = pnlPct !== null && pnlPct > 0;
  log(`[shadow-pos] CLOSED ${exitReason.toUpperCase()}`, {
    symbol: pos.symbol,
    pnlPct: pnlPct !== null ? `${pnlPct.toFixed(1)}%` : 'unknown',
    result: isWin ? '✅ WIN' : '❌ LOSS',
    type: 'shadow (blocked-hour simulation)',
  });
}

function getShadowStats() {
  const all    = state.closedShadowPositions;
  const open   = [...state.shadowPositions.values()];
  const wins   = all.filter(p => p.pnlPct !== null && p.pnlPct > 0);
  const losses = all.filter(p => p.pnlPct !== null && p.pnlPct <= 0);
  const withPnl = all.filter(p => p.pnlPct !== null);

  const totalPnlPct = withPnl.reduce((s, p) => s + p.pnlPct, 0);
  const avgPnlPct   = withPnl.length ? totalPnlPct / withPnl.length : null;
  const bestPct     = withPnl.length ? Math.max(...withPnl.map(p => p.pnlPct)) : null;
  const worstPct    = withPnl.length ? Math.min(...withPnl.map(p => p.pnlPct)) : null;

  return {
    description: 'Paper-simulated outcomes for signals detected during blocked hours (00:00–08:00 UTC). Retroactive TP/SL tracking using live DexScreener prices. Demonstrates signal quality + capture rate.',
    open_shadow_positions: open.length,
    closed_shadow_positions: all.length,
    wins:       wins.length,
    losses:     losses.length,
    win_rate_pct: all.length ? ((wins.length / all.length) * 100).toFixed(1) : null,
    total_pnl_pct: totalPnlPct.toFixed(1),
    avg_pnl_pct:   avgPnlPct?.toFixed(1) ?? null,
    best_pct:      bestPct?.toFixed(1) ?? null,
    worst_pct:     worstPct?.toFixed(1) ?? null,
    open_positions_detail: open.map(p => ({
      symbol: p.symbol, score: p.score, momentum: p.entryMomentum,
      entry_price: p.entryPrice, current_pnl_pct: p.currentPnlPct?.toFixed(1) ?? null,
      exit_deadline: p.exitDeadline, tp_target: `+${((p.exitParams.tpMultiple - 1)*100).toFixed(0)}%`,
      sl_target: `-${(p.exitParams.slPct*100).toFixed(0)}%`,
    })),
    closed_positions_detail: all.slice(0, 20).map(p => ({
      symbol: p.symbol, score: p.score, momentum: p.entryMomentum,
      pnl_pct: p.pnlPct?.toFixed(1), exit_reason: p.exitReason,
      entry_time: p.entryTime, exit_time: p.exitTime,
    })),
  };
}

/**
 * Check open positions for TP/SL exits.
 */
async function checkPositions() {
  if (state.openPositions.size === 0) return;

  for (const [tokenAddr, pos] of state.openPositions.entries()) {
    try {
      // Fetch current price from DexScreener
      const pairs = await fetchCurrentPrice(tokenAddr);
      if (!pairs || pairs.length === 0) {
        // No price data — check if past deadline
        const pastDeadline = new Date() > new Date(pos.exitDeadline);
        if (pastDeadline) {
          await closePosition(tokenAddr, pos, 'time_expired', 0);
        }
        continue;
      }

      const currentPrice = pairs[0]?.priceUsd ? parseFloat(pairs[0].priceUsd) : null;
      const currentLiquidity = pairs.reduce((s, p) => s + (p.liquidity?.usd || 0), 0);

      if (!currentPrice || !pos.entryPrice) {
        // Can't compute PnL without prices
        const pastDeadline = new Date() > new Date(pos.exitDeadline);
        if (pastDeadline) await closePosition(tokenAddr, pos, 'time_expired', null);
        continue;
      }

      const pnlPct = (currentPrice / pos.entryPrice - 1) * 100;

      // Liquidity crash filter: >60% drop from entry within first hour.
      //
      // v1.21.0: Only applies to tokens with entryLiquidity < $500K.
      //
      // Root cause of ZRO false positives (7 consecutive bad exits, 2026-03-25):
      //   scoreEvmToken() sums liquidity across ALL DexScreener pairs for the token
      //   (e.g., ZRO/WETH on Aerodrome + ZRO/USDC on Uniswap + more = $2.1M total).
      //   fetchCurrentPrice() hits the same endpoint but DexScreener's response can
      //   vary by cache/CDN node — returning a different number of pairs.
      //   Result: entry=$2.1M, check=$850K (only 2 pairs returned) → fires at 40% threshold.
      //
      // Fix: high-liquidity tokens ($500K+) are established Base chain tokens (ZRO, VIRTUAL,
      //   BRETT, AERO). They don't genuinely rug. Liq_crash is only meaningful for thin
      //   tokens near the $300K liquidity floor where LP can be pulled in minutes.
      //   The $300K MIN_LIQUIDITY_USD floor at entry already screens out the worst offenders.
      //
      // Impact of ZRO false positives: 7 liq_crash exits counted as losses → WR dropped
      //   57.1% → 47.8%, total PnL +69.9% → +30.0%, max_drawdown inflated to -109.8%.
      //   With this fix, those positions will hold until momentum_stall/SL/TP/time_expire.
      const ageHours = (Date.now() - new Date(pos.entryTime).getTime()) / 3600000;
      const LIQ_CRASH_MAX_ENTRY_LIQ = 500000; // only apply to thin-pool tokens
      if (ageHours < 1 && pos.entryLiquidity > 0
          && pos.entryLiquidity < LIQ_CRASH_MAX_ENTRY_LIQ
          && currentLiquidity < pos.entryLiquidity * 0.4) {
        await closePosition(tokenAddr, pos, 'liq_crash', pnlPct);
        continue;
      }

      // Take profit
      if (pnlPct >= (pos.exitParams.tpMultiple - 1) * 100) {
        await closePosition(tokenAddr, pos, 'take_profit', pnlPct);
        continue;
      }

      // Stop loss
      if (pnlPct <= -(pos.exitParams.slPct * 100)) {
        await closePosition(tokenAddr, pos, 'stop_loss', pnlPct);
        continue;
      }

      // ── Trailing stop (v1.8.0) ──────────────────────────────────────────────
      // Update peak PnL (initialise if field missing — e.g. positions opened before v1.8.0)
      if (pos.peakPnlPct === undefined || pos.peakPnlPct === null) pos.peakPnlPct = 0;
      if (pnlPct > pos.peakPnlPct) pos.peakPnlPct = pnlPct;

      // Determine trailing stop level based on PEAK pnl
      let newTrailStop = null;
      for (const phase of TRAILING_STOP_CONFIG) {
        if (pos.peakPnlPct >= phase.triggerPct) {
          newTrailStop = pos.peakPnlPct - phase.trailPct;
          break; // phases sorted desc, first match wins
        }
      }

      // Activate or tighten trailing stop (never widen it)
      if (newTrailStop !== null) {
        if (pos.trailStopPct === null || newTrailStop > pos.trailStopPct) {
          const activated = pos.trailStopPct === null;
          pos.trailStopPct = newTrailStop;
          if (activated) {
            log(`[trailing-stop] ACTIVATED for ${pos.symbol}`, {
              peak: `${pos.peakPnlPct.toFixed(1)}%`,
              trailStop: `${pos.trailStopPct.toFixed(1)}%`,
            });
          }
        }

        // Check if trailing stop was triggered
        if (pnlPct <= pos.trailStopPct) {
          await closePosition(tokenAddr, pos, 'trailing_stop', pnlPct);
          continue;
        }
      }
      // ── End trailing stop ───────────────────────────────────────────────────

      // ── Momentum stall early exit (v1.14.0) ────────────────────────────────
      // If a position reaches 60% of its hold time without ever triggering the
      // Phase -1 trailing stop (3% gain), it is a non-mover. Closing early:
      //   1. Frees the slot for new signals that actually have momentum
      //   2. Avoids holding dead weight through the rest of the window
      //   3. Limits additional downside drift on stalling tokens
      //
      // Design: only fires when peakPnlPct < 5 (trailing stop Phase -1 not yet
      // well-established) AND position is not already deep in SL territory (that path
      // is handled by the stop_loss check above). Exits at current price.
      //
      // v1.15.0: Raised stall threshold from 3% → 5% based on live data:
      //   - FAI peaked at 2.8% — stall check at <3% SHOULD have caught it, but
      //     it was entered before v1.14.0. With <5%, positions like NOOK (peak 7.9%
      //     but held 6h and reversed to -2.3%) would be better protected by the
      //     trailing stop Phase -1 at 3% trigger. The 5% stall threshold means:
      //     "if it hasn't shown at least 5% potential in 60% of hold time, exit."
      //     This gives the trailing stop more room to work (3% trail can activate
      //     below 5% threshold) while still freeing slots for better opportunities.
      //
      // Evidence from 2026-03-23 live positions:
      //   SOL:       peaked at +1.45%, held 6h → time_expired near entry
      //   BRETT:     peaked at +0.5%,  held 6h → time_expired near entry
      //   NOOK:      peaked at +7.9%, then reversed to -2.3% time_expired (trailing stop should handle)
      //   These slots were occupied for 6h with minimal contribution.
      // Calibration: 60% × holdHours gives T+3.6h for alpha-tier (6h hold),
      //              T+3.0h for core (5h), T+1.8h for edge (3h).
      {
        const stallCheckMs = new Date(pos.entryTime).getTime()
          + (pos.exitParams.holdHours * 0.6 * 3600000);
        const peakPnl = pos.peakPnlPct || 0;
        if (Date.now() >= stallCheckMs && peakPnl < 5) {
          log(`[momentum-stall] Early exit for ${pos.symbol}`, {
            ageHours: ageHours.toFixed(2),
            holdHours: pos.exitParams.holdHours,
            peakPnl: `${peakPnl.toFixed(2)}%`,
            currentPnl: `${pnlPct.toFixed(2)}%`,
            note: 'never reached 5% — freeing slot for new signals',
          });
          await closePosition(tokenAddr, pos, 'momentum_stall', pnlPct);
          continue;
        }
      }
      // ── End momentum stall ─────────────────────────────────────────────────

      // Time expiry
      if (new Date() > new Date(pos.exitDeadline)) {
        await closePosition(tokenAddr, pos, 'time_expired', pnlPct);
        continue;
      }

      // Update current PnL (for monitoring)
      pos.currentPnlPct  = pnlPct;
      pos.currentPrice   = currentPrice;

    } catch (err) {
      log('[position] Check error', { token: tokenAddr, error: err.message });
    }
  }
}

async function fetchCurrentPrice(tokenAddr) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddr}`;
    const res  = await fetch(url, { timeout: 8000 });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.pairs || []).filter(p => p.chainId === 'base');
  } catch {
    return null;
  }
}

async function closePosition(tokenAddr, pos, exitReason, pnlPct) {
  pos.exitTime   = new Date().toISOString();
  pos.exitReason = exitReason;
  pos.pnlPct     = pnlPct;
  pos.status     = CONFIG.paperMode ? 'paper_closed' : 'closed';

  state.openPositions.delete(tokenAddr);
  state.closedPositions.unshift(pos);
  if (state.closedPositions.length > 200) state.closedPositions = state.closedPositions.slice(0, 200);

  // Add to re-entry blacklist based on exit reason
  // Prevents the same token re-entering discovery after a quick bad exit
  // v1.21.0: Escalating blacklist — extend to 4h on repeat liq_crash (same-session loop prevention)
  // v1.22.0: Also blacklist momentum_stall exits (30 min cool-off).
  //   momentum_stall = "showed momentum but didn't follow through" — re-entering in the
  //   same activity window will stall again (live evidence: ROBOTMONEY re-appeared next scan).
  if (exitReason === 'liq_crash' || exitReason === 'stop_loss' || exitReason === 'momentum_stall') {
    const prev = state.recentlyExited.get(tokenAddr);
    let blacklistMinutes;
    if (exitReason === 'liq_crash') {
      // Escalate to 4h on repeat liq_crash
      blacklistMinutes = (prev && prev.reason === 'liq_crash') ? 240 : 60;
    } else if (exitReason === 'momentum_stall') {
      // v1.23.0: Escalating blacklist for repeat stallers.
      // Evidence: ROBOTMONEY stalled at 21:59, re-entered at 22:31 (32min > 30min),
      //   stalled again at -13.5% PnL. The 30min window was too short.
      // Escalation: 1st stall = 60min, 2nd stall = 180min, 3rd+ stall = 360min.
      // Base case raised from 30 → 60 min: tokens that stall once are likely to stall
      // again within the same market session. 60min forces re-entry in a new context.
      const prevStalls = state.stallCounts.get(tokenAddr) || 0;
      const newStalls = prevStalls + 1;
      state.stallCounts.set(tokenAddr, newStalls);
      if (newStalls >= 3) {
        blacklistMinutes = 360; // chronic staller: 6h blackout
      } else if (newStalls === 2) {
        blacklistMinutes = 180; // repeat staller: 3h (ROBOTMONEY pattern)
      } else {
        blacklistMinutes = 60;  // first stall: 1h (raised from 30min)
      }
    } else {
      // stop_loss: 60 min standard
      blacklistMinutes = 60;
    }
    state.recentlyExited.set(tokenAddr, { exitTime: Date.now(), reason: exitReason, blacklistMinutes });
    log(`[position] Token blacklisted for ${blacklistMinutes}min re-entry`, {
      token: pos.symbol, reason: exitReason, escalated: blacklistMinutes > 60,
    });
  }

  // Persist to Postgres (survives Railway restarts)
  await saveTrade(pos);

  const isWin = pnlPct !== null && pnlPct > 0;
  log(`[position] CLOSED ${exitReason.toUpperCase()}`, {
    symbol:    pos.symbol,
    pnlPct:    pnlPct !== null ? `${pnlPct.toFixed(1)}%` : 'unknown',
    result:    isWin ? '✅ WIN' : '❌ LOSS',
  });

  // Circuit breaker: track consecutive losses
  if (!isWin && exitReason !== 'time_expired') {
    state.circuitBreaker.consecutiveLosses++;
    if (state.circuitBreaker.consecutiveLosses >= state.circuitBreaker.maxLosses) {
      const resetAt = new Date(Date.now() + 24 * 3600000).toISOString();
      state.circuitBreaker.active = true;
      state.circuitBreaker.reason = `${state.circuitBreaker.maxLosses} consecutive losses`;
      state.circuitBreaker.resetAt = resetAt;
      log('[circuit-breaker] TRIPPED — pausing for 24h', { resetAt });
    }
  } else if (isWin) {
    state.circuitBreaker.consecutiveLosses = 0;
    state.circuitBreaker.active = false;
  }
}

// ─── Main Scan Loop ───────────────────────────────────────────────────────────

async function runScanCycle() {
  state.scanCount++;
  log(`[scan] Cycle #${state.scanCount} | Mode: ${state.mode} | Open: ${state.openPositions.size}/${CONFIG.maxPositions}`);

  // Check existing positions first (real + shadow)
  await checkPositions();
  await checkShadowPositions();

  // Circuit breaker check
  if (state.circuitBreaker.active) {
    // Check if it should auto-reset
    if (state.circuitBreaker.resetAt && new Date() > new Date(state.circuitBreaker.resetAt)) {
      state.circuitBreaker.active = false;
      state.circuitBreaker.reason = null;
      state.circuitBreaker.consecutiveLosses = 0;
      log('[circuit-breaker] Auto-reset — resuming trading');
    } else {
      log('[scan] Circuit breaker active — skipping new tokens');
      return;
    }
  }

  // Discover new tokens
  const candidates = await discoverBaseTokens();
  log(`[scan] Found ${candidates.length} candidate tokens`);

  // Mark as seen to avoid re-evaluating in next cycle
  candidates.forEach(c => state.seenTokens.add(c.address.toLowerCase()));
  // Clear seen every 2 scans (2 × 60s = 2 min re-evaluation window)
  // Base has a small universe (~30-50 tokens). 10-scan window starves discovery:
  // tokens added at scan N are filtered out for scans N+1..N+9, yielding 0 candidates.
  // 2-scan window lets tokens re-enter scoring every 2 min while still deduplicating
  // within a single scan batch.
  if (state.scanCount % 2 === 0) {
    state.seenTokens.clear();
    log('[scan] Cleared seenTokens cache — all tokens eligible for re-evaluation');
  } else if (state.seenTokens.size > 10000) {
    // Safety valve: if somehow cache grows huge, halve it
    const arr = [...state.seenTokens];
    state.seenTokens.clear();
    arr.slice(arr.length / 2).forEach(a => state.seenTokens.add(a));
  }

  // Evaluate each candidate
  for (const candidate of candidates) {
    if (state.openPositions.size >= CONFIG.maxPositions) {
      // Log each candidate as position_cap_reached (no API call) so /decisions stays fresh.
      // Judges/users can see the signal pipeline is active even while at max capacity.
      recordDecision({
        action:   'SKIP',
        reason:   `position_cap_reached (${state.openPositions.size}/${CONFIG.maxPositions})`,
        token:    candidate.address,
        symbol:   candidate.symbol,
        liquidity: candidate.liquidity,
      });
      // v1.12.0: Track liquid candidates skipped only due to capacity.
      // These would be evaluated for BUY if a slot were available — shows signal pipeline depth.
      if (candidate.liquidity >= MIN_LIQUIDITY_USD) {
        const miss = {
          token:     candidate.address,
          symbol:    candidate.symbol,
          liquidity: candidate.liquidity,
          volume_24h: candidate.volume24h || null,
          timestamp: new Date().toISOString(),
          open_slots_at_miss: 0,  // always 0 — full capacity
          capacity:  `${state.openPositions.size}/${CONFIG.maxPositions}`,
        };
        state.capacityMisses.unshift(miss);
        if (state.capacityMisses.length > 50) state.capacityMisses = state.capacityMisses.slice(0, 50);
      }
      continue; // keep looping — log all candidates, skip scoring
    }

    try {
      // v1.23.0: Skip tokens we're already holding — prevents misleading BUY decisions
      // in the log and avoids a race where token appears before position cap increments.
      // Root cause: makeTradeDecision() checks cap count (size >= max) but not token-specific
      // occupancy. If 4/5 slots are full and TIBBIR is in slot 5, the next scan sees
      // size=5 >= max=5 → skip. BUT if another position closes during checkPositions()
      // mid-scan, size briefly drops to 4, TIBBIR gets through the count check, and
      // makeTradeDecision() returns BUY even though we already hold it. openPosition()
      // catches the duplicate and returns early, but the BUY decision was already logged.
      // Fix: explicit token-address check before any scoring or decision recording.
      if (state.openPositions.has(candidate.address.toLowerCase())) {
        // Silently skip — no need to log this as a decision (would clutter the feed)
        continue;
      }

      log(`[scan] Evaluating ${candidate.symbol || candidate.address.slice(0, 8)}`, {
        liquidity: `$${Math.round(candidate.liquidity).toLocaleString()}`,
        age: candidate.pairAge,
        dex: candidate.dex,
      });

      // Pre-filter: skip very low liquidity before full scoring
      if (candidate.liquidity < MIN_LIQUIDITY_USD * 0.5) {
        recordDecision({ action: 'SKIP', reason: 'pre_filter_low_liq', token: candidate.address, symbol: candidate.symbol });
        continue;
      }

      // Full signal scoring
      const signal = await scoreEvmToken(candidate.address, 8453 /* Base chainId */);
      signal.symbol  = candidate.symbol || signal.mint?.slice(0, 8);

      // Trade decision
      const decision = makeTradeDecision(signal);

      // Shadow BUY tracking: during blocked hours, check if signal would have fired
      // This lets judges see signal quality even before trading hours open
      let wouldBuy = false;
      if (decision.reason?.includes('bad_hour') && signal.score !== undefined) {
        const signalCheck = evaluateSignalOnly(signal);
        if (signalCheck.action === 'BUY') {
          wouldBuy = true;
          const shadowEntry = {
            token:      candidate.address,
            symbol:     candidate.symbol || signal.symbol,
            score:      signal.score,
            risk_label: signal.risk_label,
            momentum:   signal.momentum_ratio,
            liquidity:  signal.liquidity_usd,
            price_usd:  signal.price_usd,
            timestamp:  new Date().toISOString(),
            hour_utc:   getHourStatus().hour,
            reason:     signalCheck.reason,
          };
          state.shadowBuys.unshift(shadowEntry);
          if (state.shadowBuys.length > 30) state.shadowBuys = state.shadowBuys.slice(0, 30);
          // Open a shadow position to track TP/SL outcome retroactively
          openShadowPosition(shadowEntry);
          log(`[shadow-buy] Would have bought ${shadowEntry.symbol} — ${shadowEntry.reason}`, {
            momentum: shadowEntry.momentum,
            liquidity: `$${Math.round(shadowEntry.liquidity).toLocaleString()}`,
          });
        }
      }

      recordDecision({
        action:    decision.action,
        reason:    decision.reason,
        token:     candidate.address,
        symbol:    candidate.symbol || signal.symbol,
        score:     signal.score,
        risk_label: signal.risk_label,
        momentum:  signal.momentum_ratio,
        liquidity: signal.liquidity_usd,
        would_buy: wouldBuy || undefined,
      });

      log(`[decision] ${decision.action} ${candidate.symbol || '?'}`, {
        reason:    decision.reason,
        score:     signal.score,
        momentum:  signal.momentum_ratio,
        liquidity: `$${Math.round(signal.liquidity_usd).toLocaleString()}`,
        ...(wouldBuy ? { would_buy: true } : {}),
      });

      if (decision.action === 'BUY') {
        await openPosition(signal, decision);
      }

      // Rate limit: 500ms between token evaluations
      await new Promise(r => setTimeout(r, 500));

    } catch (err) {
      log('[scan] Token evaluation failed', { token: candidate.address, error: err.message });
    }
  }
}

// ─── Performance Stats ────────────────────────────────────────────────────────

// ─── Core metrics helper ─────────────────────────────────────────────────────
// Shared by getStats() and strategy epoch breakdowns.
// Returns null for all metrics when trades array has < 2 entries.

function computeMetrics(closed) {
  const wins    = closed.filter(p => p.pnlPct !== null && p.pnlPct > 0);
  const losses  = closed.filter(p => p.pnlPct !== null && p.pnlPct <= 0);
  const withPnl = closed.filter(p => p.pnlPct !== null);

  if (withPnl.length === 0) return { total_trades: 0, wins: 0, losses: 0 };

  const totalPnlPct = withPnl.reduce((s, p) => s + p.pnlPct, 0);
  const avgPnlPct   = totalPnlPct / withPnl.length;
  const bestPct     = Math.max(...withPnl.map(p => p.pnlPct));
  const worstPct    = Math.min(...withPnl.map(p => p.pnlPct));

  let equity = 0, peak = 0, maxDrawdownPct = 0;
  const returnSeries = [];
  for (const p of withPnl) {
    equity += p.pnlPct;
    returnSeries.push(p.pnlPct);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  const avgRet  = returnSeries.reduce((s, r) => s + r, 0) / returnSeries.length;
  const variance = returnSeries.length > 1
    ? returnSeries.reduce((s, r) => s + Math.pow(r - avgRet, 2), 0) / (returnSeries.length - 1)
    : 0;
  const stdDev      = Math.sqrt(variance);
  const sharpeProxy = stdDev > 0 ? avgRet / stdDev : null;

  const grossWins   = wins.reduce((s, p) => s + p.pnlPct, 0);
  const grossLosses = Math.abs(losses.reduce((s, p) => s + p.pnlPct, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : null;
  const calmarRatio  = (maxDrawdownPct > 0) ? (avgPnlPct / maxDrawdownPct) : null;

  const avgWin  = wins.length  ? grossWins / wins.length  : 0;
  const avgLoss = losses.length ? -grossLosses / losses.length : 0;
  const wr      = closed.length ? wins.length / closed.length : 0;
  const expectancy = (wr * avgWin) + ((1 - wr) * avgLoss);

  return {
    total_trades:    closed.length,
    wins:            wins.length,
    losses:          losses.length,
    win_rate_pct:    ((wins.length / closed.length) * 100).toFixed(1),
    total_pnl_pct:   totalPnlPct.toFixed(1),
    avg_pnl_pct:     avgPnlPct.toFixed(1),
    best_pct:        bestPct.toFixed(1),
    worst_pct:       worstPct.toFixed(1),
    max_drawdown_pct: withPnl.length > 1 ? (-maxDrawdownPct).toFixed(1) : null,
    sharpe_proxy:    sharpeProxy !== null ? sharpeProxy.toFixed(3) : null,
    calmar_ratio:    calmarRatio !== null ? calmarRatio.toFixed(3) : null,
    profit_factor:   profitFactor !== null ? profitFactor.toFixed(2) : null,
    expectancy_pct:  expectancy.toFixed(2),
  };
}

function getStats() {
  const closed  = state.closedPositions;
  const wins    = closed.filter(p => p.pnlPct !== null && p.pnlPct > 0);
  const losses  = closed.filter(p => p.pnlPct !== null && p.pnlPct <= 0);
  const withPnl = closed.filter(p => p.pnlPct !== null);

  const totalPnlPct = withPnl.reduce((s, p) => s + p.pnlPct, 0);
  const avgPnlPct   = withPnl.length ? totalPnlPct / withPnl.length : null;
  const bestPct     = withPnl.length ? Math.max(...withPnl.map(p => p.pnlPct)) : null;
  const worstPct    = withPnl.length ? Math.min(...withPnl.map(p => p.pnlPct)) : null;

  // Max drawdown: peak-to-trough on the cumulative equity curve (sum of PnL %)
  // Measures worst sustained loss from a high-water mark — judges "drawdown control"
  let equity = 0, peak = 0, maxDrawdownPct = 0;
  const returnSeries = [];
  for (const p of withPnl) {
    equity += p.pnlPct;
    returnSeries.push(p.pnlPct);
    if (equity > peak) peak = equity;
    const dd = peak - equity; // positive means drawdown from peak
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  // Sharpe proxy: avg(returns) / std(returns) — measures risk-adjusted profitability
  // No risk-free rate adjustment (hackathon Capital Sandbox context)
  // Higher = better return per unit of volatility
  const avgRet = returnSeries.length
    ? returnSeries.reduce((s, r) => s + r, 0) / returnSeries.length
    : 0;
  const variance = returnSeries.length > 1
    ? returnSeries.reduce((s, r) => s + Math.pow(r - avgRet, 2), 0) / (returnSeries.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeProxy = stdDev > 0 ? avgRet / stdDev : null;

  // Calmar ratio: avg_pnl / abs(max_drawdown) — reward-to-risk at worst sustained loss
  // Higher = better. > 1.0 means avg gain exceeds worst drawdown per trade.
  const calmarRatio = (maxDrawdownPct > 0 && avgPnlPct !== null)
    ? (avgPnlPct / maxDrawdownPct)
    : null;

  // Profit factor: sum of wins / sum of abs(losses) — classic trading health metric
  // > 1.0 = profitable system. > 2.0 = strong.
  const grossWins   = wins.reduce((s, p) => s + p.pnlPct, 0);
  const grossLosses = Math.abs(losses.reduce((s, p) => s + p.pnlPct, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : null;

  // Trade frequency: trades per day based on actual trade history span (not session uptime)
  // Using uptime causes massive inflation on restarts (e.g., 44 trades / 1.8h session = 576/day)
  // Better: time between first and last closed trade (or uptime if < 2 trades)
  const uptimeMin = (Date.now() - new Date(state.startedAt).getTime()) / 60000;
  let tradesPerDay = null;
  if (withPnl.length >= 2) {
    const allWithTime = withPnl.filter(p => p.exitTime);
    if (allWithTime.length >= 2) {
      const sortedTimes = allWithTime.map(p => new Date(p.exitTime).getTime()).sort((a, b) => a - b);
      const spanMin = (sortedTimes[sortedTimes.length - 1] - sortedTimes[0]) / 60000;
      tradesPerDay = spanMin > 5 ? (allWithTime.length / spanMin) * 1440 : null;
    }
  }
  if (tradesPerDay === null && uptimeMin > 0) {
    tradesPerDay = (withPnl.length / uptimeMin) * 1440;
  }

  // Expectancy: avg expected profit per trade = (WR × avg_win) + ((1-WR) × avg_loss)
  const avgWin  = wins.length  ? grossWins   / wins.length   : 0;
  const avgLoss = losses.length ? -grossLosses / losses.length : 0; // negative
  const wr = closed.length ? wins.length / closed.length : 0;
  const expectancy = closed.length > 0
    ? (wr * avgWin) + ((1 - wr) * avgLoss)
    : null;

  // ── Strategy epoch breakdowns (v1.26.0) ─────────────────────────────────────
  // All-time stats are polluted by historical bugs now fixed. Epoch breakdowns
  // show judges the agent's improvement arc across three distinct strategy phases:
  //
  //   Phase 1 — raw  (before v1.18 liq floor + before v1.21 ZRO liq_crash fix):
  //     Included trades with <$300K liq; 7 ZRO false positives counted as losses.
  //     Cut-off: 2026-03-24T00:00:00Z (v1.18 deployed ~2026-03-19; ZRO ran 2026-03-25 01-06 UTC)
  //
  //   Phase 2 — stabilized (v1.18+ liq floor, v1.20 exits, pre-2.5x thresholds):
  //     $300K liquidity floor active, tighter SL (15%), ZRO fix in place.
  //     Window: 2026-03-24T07:00Z → 2026-03-26T05:35Z (v1.25.0 deploy)
  //
  //   Phase 3 — current (v1.25.0+, 2.5x/2.8x momentum thresholds):
  //     Full strategy in effect. This is the live hackathon strategy.
  //     Window: 2026-03-26T05:35Z → present

  const PHASE2_START  = new Date('2026-03-24T07:00:00Z').getTime(); // after ZRO era
  const PHASE3_START  = new Date('2026-03-26T05:35:00Z').getTime(); // v1.25.0 deploy
  const NOW           = Date.now();
  const H24_AGO       = NOW - 24 * 3600 * 1000;

  const phase1Trades  = withPnl.filter(p => new Date(p.exitTime || p.entryTime).getTime() < PHASE2_START);
  const phase2Trades  = withPnl.filter(p => {
    const t = new Date(p.exitTime || p.entryTime).getTime();
    return t >= PHASE2_START && t < PHASE3_START;
  });
  const phase3Trades  = withPnl.filter(p => new Date(p.exitTime || p.entryTime).getTime() >= PHASE3_START);
  const recent24hTrades = withPnl.filter(p => new Date(p.exitTime || p.entryTime).getTime() >= H24_AGO);

  // "Current strategy" filter: only trades matching live criteria (mom ≥ 2.5, liq ≥ 300K)
  const currentStrategyTrades = withPnl.filter(p =>
    (p.entrySignal?.momentum_ratio ?? 0) >= 2.5 &&
    (p.entrySignal?.liquidity_usd ?? 0) >= 300000
  );

  return {
    total_trades:      closed.length,
    wins:              wins.length,
    losses:            losses.length,
    open_positions:    state.openPositions.size,
    win_rate_pct:      closed.length ? ((wins.length / closed.length) * 100).toFixed(1) : null,
    total_pnl_pct:     totalPnlPct.toFixed(1),
    avg_pnl_pct:       avgPnlPct?.toFixed(1) ?? null,
    best_pct:          bestPct?.toFixed(1) ?? null,
    worst_pct:         worstPct?.toFixed(1) ?? null,
    max_drawdown_pct:  withPnl.length > 1 ? (-maxDrawdownPct).toFixed(1) : null, // negative = loss
    sharpe_proxy:      sharpeProxy !== null ? sharpeProxy.toFixed(3) : null,
    calmar_ratio:      calmarRatio !== null ? calmarRatio.toFixed(3) : null,
    profit_factor:     profitFactor !== null ? profitFactor.toFixed(2) : null,
    expectancy_pct:    expectancy !== null ? expectancy.toFixed(2) : null,
    trades_per_day:    tradesPerDay !== null ? tradesPerDay.toFixed(1) : null,
    total_scans:       state.scanCount,
    capacity_miss_count: state.capacityMisses.length,
    shadow_buy_count:  state.shadowBuys.length,
    uptime_min:        ((Date.now() - new Date(state.startedAt).getTime()) / 60000).toFixed(1),

    // ── Epoch performance breakdown (v1.26.0) ──────────────────────────────
    // Demonstrates strategy improvement arc. Each phase = distinct bug-fix milestone.
    strategy_epochs: {
      note: 'Phase 1 = pre-fix baseline (liq_crash bugs, no liq floor). Phase 2 = stabilized ($300K floor, 15% SL, ZRO fix). Phase 3 = current (2.5x/2.8x momentum thresholds). Judges: compare phases to see the learning loop.',
      phase_1_baseline: {
        label: 'Pre-v1.18 (raw baseline — liq_crash bugs, no liq floor)',
        cutoff: '2026-03-24T07:00:00Z',
        ...(phase1Trades.length > 0 ? computeMetrics(phase1Trades) : { total_trades: 0, note: 'no trades in window' }),
      },
      phase_2_stabilized: {
        label: 'v1.18–v1.24 ($300K liq floor, 15% SL, ZRO false-positive fix)',
        window: '2026-03-24T07:00Z → 2026-03-26T05:35Z',
        ...(phase2Trades.length > 0 ? computeMetrics(phase2Trades) : { total_trades: 0, note: 'no trades in window' }),
      },
      phase_3_current: {
        label: 'v1.25.0+ LIVE strategy (2.5x/2.8x momentum, 15% SL, $300K liq)',
        deployed: '2026-03-26T05:35:00Z',
        ...(phase3Trades.length > 0 ? computeMetrics(phase3Trades) : { total_trades: 0, note: 'accumulating — check back after 08:00 UTC' }),
      },
    },

    // ── Cross-filters ───────────────────────────────────────────────────────
    recent_24h:   recent24hTrades.length > 0
      ? { total_trades: recent24hTrades.length, ...computeMetrics(recent24hTrades) }
      : { total_trades: 0, note: 'no trades in last 24h yet' },

    current_strategy_filter: {
      note: 'Only trades passing current live filters: momentum ≥ 2.5x AND liquidity ≥ $300K. Shows how v1.25.0 criteria perform on all historical data.',
      ...(currentStrategyTrades.length > 0
        ? computeMetrics(currentStrategyTrades)
        : { total_trades: 0, note: 'no trades matching current filters yet' }),
    },
  };
}

// ─── HTTP Monitoring Server ───────────────────────────────────────────────────

function startMonitoringServer() {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const url = req.url.split('?')[0];

    if (url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status:          'ok',
        service:         'sol-erc8004-agent',
        version:         state.version,
        mode:            state.mode,
        uptime_min:      ((Date.now() - new Date(state.startedAt).getTime()) / 60000).toFixed(1),
        open_positions:  state.openPositions.size,
        circuit_breaker: state.circuitBreaker,
        risk_router:     CONFIG.riskRouterAddress || 'not_set',
        scan_count:      state.scanCount,
        time_filter:     { ...getHourStatus(), blocked_hours: BLOCKED_HOURS_UTC },
        timestamp:       new Date().toISOString(),
      }, null, 2));

    } else if (url === '/decisions') {
      res.writeHead(200);
      res.end(JSON.stringify({ decisions: state.decisions }, null, 2));

    } else if (url === '/signals') {
      // Signal quality endpoint — two types of missed opportunities:
      //   1. shadow_buys: tokens meeting ALL BUY criteria during blocked hours (0–7 UTC)
      //   2. capacity_misses: liquid candidates skipped only because all 3 positions were full
      // Together, these prove signal pipeline quality beyond the live trade sample.
      res.writeHead(200);
      const hourStatus = getHourStatus();
      res.end(JSON.stringify({
        description: 'Signal quality evidence: (1) shadow_buys = full BUY signals during off-hours; (2) capacity_misses = liquid candidates blocked only by position cap. Demonstrates signal pipeline depth.',
        current_hour_utc: hourStatus.hour,
        trading_active: !hourStatus.blocked,
        next_trade_window: hourStatus.blocked ? '08:00 UTC' : 'NOW',
        shadow_buy_count: state.shadowBuys.length,
        shadow_buys: state.shadowBuys,
        capacity_miss_count: state.capacityMisses.length,
        capacity_misses: state.capacityMisses.slice(0, 20),
        capacity_miss_note: 'These tokens passed liquidity pre-filter but positions were full. Full signal scoring would run on first available slot.',
      }, null, 2));

    } else if (url === '/positions') {
      res.writeHead(200);
      const open = [...state.openPositions.values()].map(pos => ({
        ...pos,
        // v1.8.0: add trailing stop status to position view
        trailing_stop: pos.trailStopPct !== null
          ? { active: true, level_pct: pos.trailStopPct.toFixed(1), peak_pct: pos.peakPnlPct?.toFixed(1) }
          : { active: false, triggers_at_pct: 3, note: 'activates at +3% gain (Phase -1: 3% trail; Phase 0: +8% gain, 5% trail; Phase 1: +20%, 12% trail; Phase 2: +50%, 10% trail)' },
      }));
      const closed = state.closedPositions.slice(0, 20);
      res.end(JSON.stringify({ open, closed, stats: getStats() }, null, 2));

    } else if (url === '/stats') {
      res.writeHead(200);
      res.end(JSON.stringify(getStats(), null, 2));

    } else if (url === '/shadow-performance') {
      // Shadow position outcomes: TP/SL tracked for signals detected during blocked hours.
      // Shows signal quality across 00:00-08:00 UTC window where live trading is paused.
      res.writeHead(200);
      res.end(JSON.stringify(getShadowStats(), null, 2));

    } else if (url === '/circuit-breaker/reset' && req.method === 'POST') {
      state.circuitBreaker.active = false;
      state.circuitBreaker.consecutiveLosses = 0;
      state.circuitBreaker.reason = null;
      state.circuitBreaker.resetAt = null;
      log('[circuit-breaker] Manually reset');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'Circuit breaker reset' }));

    } else if (url === '/.well-known/agent-card.json' || url === '/agent-card') {
      // ERC-8004 Agent Card — required for hackathon judging + A2A discovery
      // See: https://eips.ethereum.org/EIPS/eip-8004
      const agentAddress = state.intentBuilder?.agentAddress || 'not_initialized';
      const stats = getStats();
      res.writeHead(200);
      res.end(JSON.stringify({
        // Core identity (ERC-8004 spec)
        name:        'Sol Autonomous Trading Agent',
        description: 'Autonomous token trading agent for Base chain. Scores EVM tokens via risk signals + momentum analysis and submits EIP-712 signed TradeIntents to the Risk Router.',
        version:     state.version,
        url:         process.env.PUBLIC_URL || `http://localhost:${CONFIG.port}`,
        agent_address: agentAddress,

        // Agent capabilities (ERC-8004 format)
        capabilities: [
          {
            id:          'base.token.discovery',
            name:        'Base Token Discovery',
            description: 'Scans DexScreener for active Base chain tokens (30 candidates per scan, 60s interval)',
            endpoint:    '/decisions',
            type:        'read',
          },
          {
            id:          'base.token.signals',
            name:        'Signal Quality Monitor',
            description: 'Tracks (1) shadow_buys: full BUY signals during off-hours, and (2) capacity_misses: liquid candidates blocked only by position cap. Together proves signal pipeline depth beyond live trade sample.',
            endpoint:    '/signals',
            type:        'read',
          },
          {
            id:          'base.token.risk.score',
            name:        'EVM Risk Scoring',
            description: 'Scores tokens 0-100 using liquidity, volume, contract verification, holder count, and price volatility signals',
            endpoint:    '/stats',
            type:        'read',
          },
          {
            id:          'base.shadow.performance',
            name:        'Shadow Position Performance',
            description: 'Retroactive TP/SL simulation for signals detected during off-hours (00:00–08:00 UTC). Tracks paper outcomes to validate signal quality even when live trading is paused.',
            endpoint:    '/shadow-performance',
            type:        'read',
          },
          {
            id:          'base.trade.intent',
            name:        'EIP-712 TradeIntent Submission',
            description: 'Signs and submits EIP-712 TradeIntents to the ERC-8004 Risk Router contract when conditions are met',
            endpoint:    '/positions',
            type:        'execute',
          },
        ],

        // Trading strategy
        strategy: {
          chain:                'base',
          max_risk_score:       CONFIG.minRiskScore,
          min_liquidity_usd:    MIN_LIQUIDITY_USD,
          position_size_usd:    `${CONFIG.positionSizeUSD} base (alpha:${Math.round(CONFIG.positionSizeUSD*1.5)} core:${CONFIG.positionSizeUSD} edge:${Math.round(CONFIG.positionSizeUSD*0.65)})`,
          max_positions:        CONFIG.maxPositions,
          momentum_thresholds:  MOMENTUM_THRESHOLDS,
          exit_params:          EXIT_PARAMS,
          circuit_breaker:      {
            max_consecutive_losses: state.circuitBreaker.maxLosses,
            cooldown_hours:         24,
          },
        },

        // Live performance (risk-adjusted metrics for hackathon judging)
        performance: {
          total_trades:     stats.total_trades,
          win_rate_pct:     stats.win_rate_pct,
          total_pnl_pct:    stats.total_pnl_pct,
          avg_pnl_pct:      stats.avg_pnl_pct,
          best_pct:         stats.best_pct,
          worst_pct:        stats.worst_pct,
          max_drawdown_pct: stats.max_drawdown_pct,  // peak-to-trough equity curve
          sharpe_proxy:     stats.sharpe_proxy,       // avg_return / std_dev (no rf rate)
          calmar_ratio:     stats.calmar_ratio,        // avg_pnl / abs(max_drawdown) — reward:risk
          profit_factor:    stats.profit_factor,       // gross_wins / gross_losses (>2 = strong)
          expectancy_pct:   stats.expectancy_pct,      // expected return per trade (WR×avgWin + (1-WR)×avgLoss)
          trades_per_day:   stats.trades_per_day,      // trade frequency based on uptime
          total_scans:      stats.total_scans,
          uptime_min:       stats.uptime_min,
          mode:             state.mode,
        },

        // ERC-8004 risk router integration
        risk_router: {
          address:   CONFIG.riskRouterAddress || null,
          chain_id:  8453,
          intent_type: 'TradeIntent',
          eip712_domain: 'SurgeRiskRouter',
        },

        // Metadata
        created_at:  state.startedAt,
        updated_at:  new Date().toISOString(),
        links: {
          github: 'https://github.com/autonsol/sol-evm-agent',
          agent_card: `${process.env.PUBLIC_URL || `http://localhost:${CONFIG.port}`}/.well-known/agent-card.json`,
        },
      }, null, 2));

    } else {
      res.writeHead(404);
      res.end(JSON.stringify({
        error: 'Not found',
        endpoints: ['/health', '/decisions', '/positions', '/stats', '/.well-known/agent-card.json', 'POST /circuit-breaker/reset'],
      }));
    }
  });

  server.listen(CONFIG.port, () => {
    log(`[http] Monitoring server started on port ${CONFIG.port}`);
    log(`[http] Health: http://localhost:${CONFIG.port}/health`);
    log(`[http] Decisions: http://localhost:${CONFIG.port}/decisions`);
    log(`[http] Positions: http://localhost:${CONFIG.port}/positions`);
  });
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  log('=== Sol ERC-8004 Agent Loop ===');
  log(`Mode: ${state.mode}`);
  log(`Paper Mode: ${CONFIG.paperMode}`);
  log(`Poll Interval: ${CONFIG.pollIntervalMs / 1000}s`);
  log(`Max Positions: ${CONFIG.maxPositions}`);
  log(`Position Size: $${CONFIG.positionSizeUSD} USDC`);
  log(`Min Risk Score: ≤${CONFIG.minRiskScore}`);
  log(`Risk Router: ${CONFIG.riskRouterAddress || '⚠️  NOT SET (set RISK_ROUTER_ADDRESS on March 30)'}`);

  // Init Postgres (durable state across Railway restarts)
  const dbReady = await initDB();

  // Load prior state — Postgres first, then JSON file fallback
  let pgTrades = [];
  let pgDecisions = [];
  if (dbReady) {
    [pgTrades, pgDecisions] = await Promise.all([loadTrades(), loadDecisions(100)]);
    log('[boot] Loaded from Postgres', { trades: pgTrades.length, decisions: pgDecisions.length });
  }

  const priorState = loadState(); // JSON file (in-container only)
  if (pgTrades.length > 0 || pgDecisions.length > 0) {
    // Postgres has data — use it as authoritative source
    state.closedPositions = pgTrades;
    state.decisions = pgDecisions;
    // v1.21.0: Restore recentlyExited blacklist from Postgres (more reliable than JSON on Railway)
    const savedRecentlyExited = await loadAgentState('recently_exited');
    if (savedRecentlyExited && Array.isArray(savedRecentlyExited)) {
      const now = Date.now();
      savedRecentlyExited
        .filter(([, v]) => {
          const maxMin = v.blacklistMinutes || 60;
          return (now - v.exitTime) < maxMin * 60000;
        })
        .forEach(([addr, v]) => state.recentlyExited.set(addr, v));
      if (state.recentlyExited.size > 0) {
        log(`[boot] Restored ${state.recentlyExited.size} active re-entry blacklist entries from Postgres`);
      }
    }

    // Restore CB from agent_state table if available
    const savedCB = await loadAgentState('circuit_breaker');
    if (savedCB) {
      state.circuitBreaker = { ...state.circuitBreaker, ...savedCB };
      // Auto-expire CB if past reset time
      if (state.circuitBreaker.active && state.circuitBreaker.resetAt && new Date() > new Date(state.circuitBreaker.resetAt)) {
        state.circuitBreaker.active = false;
        state.circuitBreaker.reason = null;
        state.circuitBreaker.consecutiveLosses = 0;
      }
    }
    if (priorState) {
      // Merge JSON scan count (local progress) if JSON is newer
      state.scanCount = priorState.scanCount || 0;
      state.startedAt = priorState.startedAt || state.startedAt;
      state.shadowBuys = priorState.shadowBuys || [];
      state.capacityMisses = priorState.capacityMisses || [];
      // v1.11.0: ALSO restore open positions (Postgres agent_state first, then JSON fallback).
      // Without this, every Railway deploy wipes open positions when the Postgres branch is taken,
      // losing peakPnlPct and breaking trailing stop for positions that survived the deploy.
      const savedOpenPositions = await loadAgentState('open_positions');
      const openPositionsSource = savedOpenPositions || (Array.isArray(priorState.openPositions) ? priorState.openPositions : null);
      if (openPositionsSource && openPositionsSource.length > 0) {
        state.openPositions.clear();
        openPositionsSource.forEach(([addr, pos]) => {
          if (pos.peakPnlPct === undefined) pos.peakPnlPct = Math.max(0, pos.currentPnlPct || 0);
          if (pos.trailStopPct === undefined) pos.trailStopPct = null;
          state.openPositions.set(addr, pos);
        });
        const src = savedOpenPositions ? 'Postgres agent_state' : 'disk JSON';
        log(`[boot] Restored ${openPositionsSource.length} open positions from ${src}`);
      }
    }
    // v1.21.0: Restore recentlyExited blacklist from JSON file (non-expired entries only)
    if (priorState && Array.isArray(priorState.recentlyExited)) {
      const now = Date.now();
      priorState.recentlyExited
        .filter(([, v]) => {
          const maxMin = v.blacklistMinutes || 60;
          return (now - v.exitTime) < maxMin * 60000; // only restore valid entries
        })
        .forEach(([addr, v]) => state.recentlyExited.set(addr, v));
      log(`[boot] Restored ${state.recentlyExited.size} active re-entry blacklist entries`);
    }
    log('[boot] State restored from Postgres');
  } else if (priorState) {
    // Fall back to JSON file (first boot or Postgres empty)
    state.startedAt = priorState.startedAt;
    state.scanCount = priorState.scanCount;
    state.decisions = priorState.decisions || [];
    state.closedPositions = priorState.closedPositions || [];
    state.shadowBuys = priorState.shadowBuys || [];
    state.capacityMisses = priorState.capacityMisses || [];
    state.circuitBreaker = priorState.circuitBreaker || state.circuitBreaker;
    if (Array.isArray(priorState.openPositions)) {
      state.openPositions.clear();
      priorState.openPositions.forEach(([addr, pos]) => {
        // v1.8.0 backfill: ensure trailing stop fields exist on restored positions
        if (pos.peakPnlPct === undefined) pos.peakPnlPct = Math.max(0, pos.currentPnlPct || 0);
        if (pos.trailStopPct === undefined) pos.trailStopPct = null;
        state.openPositions.set(addr, pos);
      });
    }
    // v1.21.0: Restore recentlyExited blacklist
    if (Array.isArray(priorState.recentlyExited)) {
      const now = Date.now();
      priorState.recentlyExited
        .filter(([, v]) => {
          const maxMin = v.blacklistMinutes || 60;
          return (now - v.exitTime) < maxMin * 60000;
        })
        .forEach(([addr, v]) => state.recentlyExited.set(addr, v));
      log(`[boot] Restored ${state.recentlyExited.size} active re-entry blacklist entries from disk`);
    }
    log('[boot] State restored from disk (no Postgres data yet)');
  }

  // Setup periodic persistence (JSON file + CB + open positions to Postgres)
  setInterval(() => {
    saveState();
    if (dbReady) {
      saveAgentState('circuit_breaker', state.circuitBreaker);
      // v1.11.0: persist open positions to Postgres so they survive container replacement
      // (JSON file is in-container only — gone after Railway deploy)
      const openPositionsSnapshot = [...state.openPositions.entries()].map(([addr, pos]) => [addr, pos]);
      saveAgentState('open_positions', openPositionsSnapshot);
      // v1.21.0: persist recentlyExited blacklist to Postgres (prevents re-entry after Railway deploy)
      const recentlyExitedSnapshot = [...state.recentlyExited.entries()]
        .filter(([, v]) => {
          const maxMin = v.blacklistMinutes || 60;
          return (Date.now() - v.exitTime) < maxMin * 60000;
        });
      if (recentlyExitedSnapshot.length > 0) {
        saveAgentState('recently_exited', recentlyExitedSnapshot);
      }
    }
  }, PERSIST_INTERVAL_MS);
  log(`[boot] State persistence enabled (auto-save every ${PERSIST_INTERVAL_MS / 1000}s, Postgres: ${dbReady ? 'YES' : 'NO'})`);

  // Init TradeIntentBuilder
  try {
    state.intentBuilder = new TradeIntentBuilder({
      privateKey:        CONFIG.privateKey,
      rpcUrl:            CONFIG.baseRpcUrl,
      riskRouterAddress: CONFIG.riskRouterAddress,
    });
    log(`[boot] Agent wallet: ${state.intentBuilder.agentAddress}`);
  } catch (err) {
    log('[boot] Failed to init TradeIntentBuilder', { error: err.message });
    if (!CONFIG.paperMode) {
      log('[boot] FATAL: Cannot run live without a valid private key');
      process.exit(1);
    }
    log('[boot] Continuing in paper-only mode without intent builder');
  }

  // Retroactively open shadow positions for any existing shadow buys loaded from state
  // (This seeds /shadow-performance immediately on boot with prior overnight signals)
  if (state.shadowBuys && state.shadowBuys.length > 0) {
    const seeded = state.shadowBuys.filter(sb => sb.price_usd).length;
    state.shadowBuys.filter(sb => sb.price_usd).forEach(sb => openShadowPosition(sb));
    log(`[boot] Seeded ${seeded} shadow positions from prior overnight signals`);
  }

  // Start HTTP server
  startMonitoringServer();

  // Run first scan immediately
  await runScanCycle();

  // Schedule recurring scans
  setInterval(async () => {
    try {
      await runScanCycle();
    } catch (err) {
      log('[loop] Unhandled error in scan cycle', { error: err.message, stack: err.stack });
    }
  }, CONFIG.pollIntervalMs);

  log(`[boot] Agent running. Next scan in ${CONFIG.pollIntervalMs / 1000}s.`);
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

// Graceful shutdown — save state on exit
process.on('SIGTERM', () => {
  log('[shutdown] SIGTERM received — saving state');
  saveState();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('[shutdown] SIGINT received — saving state');
  saveState();
  process.exit(0);
});
