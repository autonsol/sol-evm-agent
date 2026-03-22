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
// Thresholds set at 60th-70th percentile of "active but not parabolic" range:
const MOMENTUM_THRESHOLDS = {
  30: 1.5,  // risk ≤ 30 (alpha zone): 1.5x composite momentum
  50: 1.8,  // risk 31-50: 1.8x
  65: 2.2,  // risk 51-65: 2.2x
};

// Exit params by risk band (mirrors grad-alert v5.6)
const EXIT_PARAMS = {
  30: { tpMultiple: 3.0, slPct: 0.30, holdHours: 24 },
  50: { tpMultiple: 2.5, slPct: 0.30, holdHours: 12 },
  65: { tpMultiple: 2.0, slPct: 0.30, holdHours: 6  },
};

// Liquidity floor (USD) — don't trade tokens below this
const MIN_LIQUIDITY_USD = 10_000;

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
    const snapshot = {
      startedAt: state.startedAt,
      version: state.version,
      scanCount: state.scanCount,
      decisions: state.decisions.slice(0, 50), // keep last 50 for replay
      openPositions: [...state.openPositions.entries()].map(([addr, pos]) => [addr, pos]),
      closedPositions: state.closedPositions.slice(0, 100), // keep last 100
      circuitBreaker: state.circuitBreaker,
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
  version:      '1.7.0',
  mode:         CONFIG.paperMode ? 'PAPER' : 'LIVE',
  scanCount:    0,
  decisions:    [],           // last 100 decisions
  shadowBuys:   [],           // would-have-been BUY signals during blocked hours (last 30)
  shadowPositions: new Map(), // shadow paper positions opened from shadow buys (token → pos)
  closedShadowPositions: [],  // historical closed shadow positions (for /shadow-performance)
  openPositions: new Map(),   // tokenAddress → position
  closedPositions: [],        // historical closed positions
  seenTokens:   new Set(),    // avoid re-scanning same tokens in short window
  intentBuilder: null,        // TradeIntentBuilder instance
  circuitBreaker: {
    active: false,
    reason: null,
    resetAt: null,
    consecutiveLosses: 0,
    maxLosses: 5,
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

  // Liquidity floor
  if (signal.liquidity_usd < MIN_LIQUIDITY_USD) {
    return { action: 'SKIP', reason: `low_liquidity ($${Math.round(signal.liquidity_usd)} < $${MIN_LIQUIDITY_USD})` };
  }

  // No momentum data
  if (!signal.momentum_ratio || signal.momentum_ratio <= 0) {
    return { action: 'SKIP', reason: 'no_momentum_data' };
  }

  // Momentum threshold (tiered by risk score)
  // During prime hours (13–17 UTC, US/EU overlap), apply a -0.2x discount on the
  // required momentum to catch more entries during peak Base DEX activity.
  let requiredMomentum = MOMENTUM_THRESHOLDS[65] ?? 2.2; // default for risk 51-65
  if (signal.score <= 30) requiredMomentum = MOMENTUM_THRESHOLDS[30];
  else if (signal.score <= 50) requiredMomentum = MOMENTUM_THRESHOLDS[50];

  if (hourStatus.prime) {
    requiredMomentum = Math.max(requiredMomentum - 0.2, 1.2); // prime hour discount, floor 1.2x
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
  let exitParams = EXIT_PARAMS[65];
  if (signal.score <= 30) exitParams = EXIT_PARAMS[30];
  else if (signal.score <= 50) exitParams = EXIT_PARAMS[50];
  return { action: 'BUY', reason: `momentum_${signal.momentum_ratio.toFixed(1)}x_risk_${signal.score}`, exitParams };
}

// ─── Position Management ──────────────────────────────────────────────────────

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
    positionSizeUSD:  CONFIG.positionSizeUSD,
    exitParams:       decision.exitParams,
    exitDeadline:     new Date(Date.now() + decision.exitParams.holdHours * 3600000).toISOString(),
    intentHash:       null,
    txHash:           null,
    status:           CONFIG.paperMode ? 'paper_open' : 'open',
    pnlPct:           null,
    exitReason:       null,
    exitTime:         null,
  };

  // Submit TradeIntent (live mode only)
  if (!CONFIG.paperMode && state.intentBuilder) {
    try {
      const amountIn = ethers.parseUnits(CONFIG.positionSizeUSD.toString(), 6); // USDC 6 decimals
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
    symbol:  position.symbol,
    score:   signal.score,
    momentum: signal.momentum_ratio,
    tp:      `${((decision.exitParams.tpMultiple - 1) * 100).toFixed(0)}%`,
    sl:      `${(decision.exitParams.slPct * 100).toFixed(0)}%`,
    hold:    `${decision.exitParams.holdHours}h`,
    sizeUSD: CONFIG.positionSizeUSD,
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

      // Liquidity crash filter: >60% drop from entry within first hour
      const ageHours = (Date.now() - new Date(pos.entryTime).getTime()) / 3600000;
      if (ageHours < 1 && pos.entryLiquidity > 0 && currentLiquidity < pos.entryLiquidity * 0.4) {
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

      // Time expiry
      if (new Date() > new Date(pos.exitDeadline)) {
        await closePosition(tokenAddr, pos, 'time_expired', pnlPct);
        continue;
      }

      // Update current PnL (for monitoring)
      pos.currentPnlPct = pnlPct;
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
  // Clear seen every 10 scans (10 × 60s = 10 min re-evaluation window)
  // Base tokens aren't new launches — their momentum changes over time
  if (state.scanCount % 10 === 0) {
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
      log('[scan] Position cap reached — stopping evaluation');
      break;
    }

    try {
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
    total_scans:       state.scanCount,
    uptime_min:        ((Date.now() - new Date(state.startedAt).getTime()) / 60000).toFixed(1),
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
      // Shadow BUY signals — tokens that met all criteria except time-of-day filter.
      // Shows signal discovery quality during blocked hours (0–7 UTC).
      // When trading windows open (08:00+ UTC), these tokens will be actively evaluated.
      res.writeHead(200);
      const hourStatus = getHourStatus();
      res.end(JSON.stringify({
        description: 'Tokens meeting BUY criteria (risk, liquidity, momentum) discovered during blocked hours. Demonstrates signal quality independent of time filter.',
        current_hour_utc: hourStatus.hour,
        trading_active: !hourStatus.blocked,
        next_trade_window: hourStatus.blocked ? '08:00 UTC' : 'NOW',
        shadow_buy_count: state.shadowBuys.length,
        shadow_buys: state.shadowBuys,
      }, null, 2));

    } else if (url === '/positions') {
      res.writeHead(200);
      const open   = [...state.openPositions.values()];
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
            description: 'Tracks tokens meeting all BUY criteria (risk, liquidity, momentum) even during off-hours. Shows pre-validated signals ready to fire when trading windows open.',
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
          position_size_usd:    CONFIG.positionSizeUSD,
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
    }
    log('[boot] State restored from Postgres');
  } else if (priorState) {
    // Fall back to JSON file (first boot or Postgres empty)
    state.startedAt = priorState.startedAt;
    state.scanCount = priorState.scanCount;
    state.decisions = priorState.decisions || [];
    state.closedPositions = priorState.closedPositions || [];
    state.circuitBreaker = priorState.circuitBreaker || state.circuitBreaker;
    if (Array.isArray(priorState.openPositions)) {
      state.openPositions.clear();
      priorState.openPositions.forEach(([addr, pos]) => state.openPositions.set(addr, pos));
    }
    log('[boot] State restored from disk (no Postgres data yet)');
  }

  // Setup periodic persistence (JSON file + CB to Postgres)
  setInterval(() => {
    saveState();
    if (dbReady) saveAgentState('circuit_breaker', state.circuitBreaker);
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
