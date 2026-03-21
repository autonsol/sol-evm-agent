/**
 * evm-signal-adapter.js
 * 
 * Translates EVM token on-chain signals into a 0-100 risk score,
 * matching the format used by token-risk-service for Solana tokens.
 * 
 * Uses DexScreener (free, no API key) + Etherscan (free tier, optional key)
 * to gather liquidity, volume, holder, and contract data for Base/Ethereum tokens.
 * 
 * Output matches token-risk-service schema:
 *   { mint, score, risk_label, signals, liquidity_usd, volume_24h, ... }
 */

import fetch from 'node-fetch';

// ─── Config ──────────────────────────────────────────────────────────────────

const ETHERSCAN_BASE_URL = 'https://api.basescan.org/api';
const DEXSCREENER_URL    = 'https://api.dexscreener.com/latest/dex/tokens';
const ETHERSCAN_KEY      = process.env.ETHERSCAN_API_KEY || ''; // optional, increases rate limit

// Risk score bands (matches Solana token-risk-service)
const RISK_LABELS = [
  { max: 30,  label: 'LOW'      },
  { max: 50,  label: 'MODERATE' },
  { max: 65,  label: 'HIGH'     },
  { max: 100, label: 'VERY_HIGH'},
];

// ─── DexScreener Fetch ────────────────────────────────────────────────────────

async function fetchDexScreenerData(tokenAddress) {
  const url = `${DEXSCREENER_URL}/${tokenAddress}`;
  try {
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
    const data = await res.json();
    return data.pairs || [];
  } catch (err) {
    console.error('[evm-signal-adapter] DexScreener error:', err.message);
    return [];
  }
}

// ─── Etherscan / Basescan Fetch ───────────────────────────────────────────────

async function fetchContractInfo(tokenAddress, chainId = 8453) {
  // chainId 8453 = Base mainnet, 1 = Ethereum mainnet
  const baseUrl = chainId === 8453 ? ETHERSCAN_BASE_URL : 'https://api.etherscan.io/api';
  
  const results = {};
  
  // Check if contract is verified
  try {
    const keyParam = ETHERSCAN_KEY ? `&apikey=${ETHERSCAN_KEY}` : '';
    const url = `${baseUrl}?module=contract&action=getsourcecode&address=${tokenAddress}${keyParam}`;
    const res = await fetch(url, { timeout: 8000 });
    const data = await res.json();
    if (data.status === '1' && data.result?.[0]) {
      results.isVerified = data.result[0].SourceCode !== '';
      results.contractName = data.result[0].ContractName || '';
      results.compilerVersion = data.result[0].CompilerVersion || '';
    }
  } catch (err) {
    results.isVerified = null; // unknown
  }
  
  // Get token holder count
  try {
    const keyParam = ETHERSCAN_KEY ? `&apikey=${ETHERSCAN_KEY}` : '';
    const url = `${baseUrl}?module=token&action=tokeninfo&contractaddress=${tokenAddress}${keyParam}`;
    const res = await fetch(url, { timeout: 8000 });
    const data = await res.json();
    if (data.status === '1' && data.result?.[0]) {
      results.holderCount = parseInt(data.result[0].holdersCount || 0);
    }
  } catch (err) {
    results.holderCount = null; // unknown
  }
  
  return results;
}

// ─── Signal Analysis ──────────────────────────────────────────────────────────

function analyzePairs(pairs) {
  if (!pairs.length) {
    return {
      liquidity_usd: 0,
      volume_24h: 0,
      volume_6h: 0,
      volume_1h: 0,
      price_change_24h: 0,
      price_change_6h: 0,
      price_change_1h: 0,
      pair_count: 0,
      primary_dex: null,
      fdv: 0,
      age_hours: 0,
      price_usd: null,
      buys_1h: 0,
      sells_1h: 0,
    };
  }
  
  // Use the highest-liquidity pair as primary
  const primaryPair = pairs.sort((a, b) => 
    (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
  )[0];
  
  // Total liquidity across all pairs for this token
  const totalLiquidity = pairs.reduce((sum, p) => sum + (p.liquidity?.usd || 0), 0);
  
  const createdAt = primaryPair.pairCreatedAt; // unix ms
  const ageHours = createdAt 
    ? (Date.now() - createdAt) / 3600000 
    : null;

  // Parse current price (USD) from primary pair
  const priceUsd = primaryPair.priceUsd ? parseFloat(primaryPair.priceUsd) : null;
  
  return {
    liquidity_usd: totalLiquidity,
    volume_24h:    primaryPair.volume?.h24 || 0,
    volume_6h:     primaryPair.volume?.h6  || 0,
    volume_1h:     primaryPair.volume?.h1  || 0,
    price_change_24h: primaryPair.priceChange?.h24 || 0,
    price_change_6h:  primaryPair.priceChange?.h6  || 0,
    price_change_1h:  primaryPair.priceChange?.h1  || 0,
    pair_count:    pairs.length,
    primary_dex:   primaryPair.dexId || null,
    fdv:           primaryPair.fdv   || 0,
    age_hours:     ageHours,
    price_usd:     priceUsd,
    txns_24h:      (primaryPair.txns?.h24?.buys || 0) + (primaryPair.txns?.h24?.sells || 0),
    buys_24h:      primaryPair.txns?.h24?.buys  || 0,
    sells_24h:     primaryPair.txns?.h24?.sells || 0,
    buys_1h:       primaryPair.txns?.h1?.buys   || 0,
    sells_1h:      primaryPair.txns?.h1?.sells  || 0,
  };
}

// ─── Scoring Engine ────────────────────────────────────────────────────────────

function scoreToken(market, contract) {
  let score = 0;
  const signals = [];

  // ── Liquidity ────────────────────────────────────────────────────────────────
  const liq = market.liquidity_usd;
  if (liq < 5000) {
    score += 35;
    signals.push({ key: 'low_liquidity', value: liq, severity: 'high', desc: `Only $${Math.round(liq)} liquidity — extremely thin` });
  } else if (liq < 25000) {
    score += 20;
    signals.push({ key: 'moderate_liquidity', value: liq, severity: 'medium', desc: `$${Math.round(liq)} liquidity — below safe threshold` });
  } else if (liq < 100000) {
    score += 8;
    signals.push({ key: 'acceptable_liquidity', value: liq, severity: 'low', desc: `$${Math.round(liq)} liquidity — acceptable but not deep` });
  }
  // >$100K liquidity → no penalty

  // ── Volume/Liquidity Ratio (wash trading signal) ───────────────────────────
  if (liq > 0 && market.volume_24h > 0) {
    const volLiqRatio = market.volume_24h / liq;
    if (volLiqRatio > 50) {
      score += 20;
      signals.push({ key: 'wash_trading_suspected', value: volLiqRatio.toFixed(1), severity: 'high', desc: `Vol/Liq ratio ${volLiqRatio.toFixed(1)}x — likely wash trading` });
    } else if (volLiqRatio > 20) {
      score += 10;
      signals.push({ key: 'high_vol_liq_ratio', value: volLiqRatio.toFixed(1), severity: 'medium', desc: `Vol/Liq ratio ${volLiqRatio.toFixed(1)}x — elevated` });
    }
  }

  // ── Age ───────────────────────────────────────────────────────────────────────
  if (market.age_hours !== null) {
    if (market.age_hours < 1) {
      score += 25;
      signals.push({ key: 'very_new_token', value: market.age_hours.toFixed(2), severity: 'high', desc: `Token only ${(market.age_hours * 60).toFixed(0)} minutes old` });
    } else if (market.age_hours < 24) {
      score += 12;
      signals.push({ key: 'new_token', value: market.age_hours.toFixed(1), severity: 'medium', desc: `Token ${market.age_hours.toFixed(1)} hours old — elevated risk` });
    } else if (market.age_hours < 168) { // < 1 week
      score += 5;
    }
  } else {
    score += 8; // unknown age
  }

  // ── Contract Verification ─────────────────────────────────────────────────────
  if (contract.isVerified === false) {
    score += 15;
    signals.push({ key: 'unverified_contract', value: false, severity: 'high', desc: 'Contract source code not verified on-chain' });
  } else if (contract.isVerified === null) {
    score += 5; // unknown
    signals.push({ key: 'contract_verification_unknown', value: null, severity: 'low', desc: 'Could not verify contract status' });
  }

  // ── Holder Count ──────────────────────────────────────────────────────────────
  if (contract.holderCount !== null) {
    if (contract.holderCount < 50) {
      score += 15;
      signals.push({ key: 'very_few_holders', value: contract.holderCount, severity: 'high', desc: `Only ${contract.holderCount} holders — concentrated ownership` });
    } else if (contract.holderCount < 200) {
      score += 8;
      signals.push({ key: 'few_holders', value: contract.holderCount, severity: 'medium', desc: `${contract.holderCount} holders — low distribution` });
    }
  }

  // ── Price Volatility ──────────────────────────────────────────────────────────
  const priceChange1h = Math.abs(market.price_change_1h);
  if (priceChange1h > 100) {
    score += 10;
    signals.push({ key: 'extreme_price_move_1h', value: market.price_change_1h, severity: 'high', desc: `${market.price_change_1h.toFixed(1)}% 1h price move` });
  } else if (priceChange1h > 50) {
    score += 5;
    signals.push({ key: 'high_price_volatility_1h', value: market.price_change_1h, severity: 'medium', desc: `${market.price_change_1h.toFixed(1)}% 1h price move` });
  }

  // ── Buy/Sell Imbalance ────────────────────────────────────────────────────────
  const buys  = market.buys_24h;
  const sells = market.sells_24h;
  if (buys + sells > 10) {
    const ratio = buys / (buys + sells);
    if (ratio > 0.85) {
      score += 8;
      signals.push({ key: 'buy_pressure_extreme', value: ratio.toFixed(2), severity: 'medium', desc: `${(ratio * 100).toFixed(0)}% buys — coordinated pumping pattern` });
    }
    if (ratio < 0.15) {
      score += 15;
      signals.push({ key: 'sell_pressure_extreme', value: ratio.toFixed(2), severity: 'high', desc: `Only ${(ratio * 100).toFixed(0)}% buys — heavy selling` });
    }
  }

  // ── Multiple Pairs (can indicate fragmented/low-quality liquidity) ────────────
  if (market.pair_count > 5) {
    score += 5;
    signals.push({ key: 'many_pairs', value: market.pair_count, severity: 'low', desc: `Token has ${market.pair_count} DEX pairs — liquidity fragmented` });
  }

  // Clamp 0-100
  score = Math.min(100, Math.max(0, score));

  return { score, signals };
}

function getRiskLabel(score) {
  for (const band of RISK_LABELS) {
    if (score <= band.max) return band.label;
  }
  return 'VERY_HIGH';
}

// ─── Momentum Signal ──────────────────────────────────────────────────────────

function computeMomentum(market) {
  // Returns a composite momentum ratio for Base chain tokens.
  //
  // Unlike Solana pump.fun (where we watch buy/sell TX ratio in a 2-min window),
  // Base chain uses established tokens with steady volume baselines.
  // Strategy: blend volume acceleration (1h vs 24h avg) with 1h buy/sell ratio.
  //
  // Volume acceleration: 1h volume vs hourly baseline from 24h data.
  // A ratio of 2.0 = current hour is running at 2× the typical pace.
  //
  // Buy pressure: buys_1h / (buys_1h + sells_1h). Ranges 0-1.
  // Boost momentum score when >70% buys in last 1h (strong accumulation).

  if (!market.volume_24h) return null;

  const hourly24hAvg = market.volume_24h / 24;
  if (hourly24hAvg === 0) return null;

  // Volume acceleration component
  const volRatio = market.volume_1h ? (market.volume_1h / hourly24hAvg) : 1.0;

  // Buy pressure boost (optional — only if 1h txn data available)
  let buyPressureBoost = 1.0;
  const total1h = market.buys_1h + market.sells_1h;
  if (total1h >= 5) {
    const buyRatio1h = market.buys_1h / total1h;
    if (buyRatio1h > 0.70) buyPressureBoost = 1.3;  // 30% boost for strong buy pressure
    else if (buyRatio1h > 0.55) buyPressureBoost = 1.1; // 10% boost for slight buy lean
    else if (buyRatio1h < 0.30) buyPressureBoost = 0.7; // 30% penalty for heavy selling
  }

  const composite = volRatio * buyPressureBoost;
  return parseFloat(composite.toFixed(2));
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Score an EVM token address and return a risk signal.
 * 
 * @param {string} tokenAddress  - EVM token contract address (0x...)
 * @param {number} chainId       - 8453 for Base, 1 for Ethereum mainnet
 * @returns {Promise<Object>} Risk signal in token-risk-service format
 */
export async function scoreEvmToken(tokenAddress, chainId = 8453) {
  const address = tokenAddress.toLowerCase();
  
  const [pairs, contract] = await Promise.all([
    fetchDexScreenerData(address),
    fetchContractInfo(address, chainId),
  ]);
  
  const market  = analyzePairs(pairs);
  const { score, signals } = scoreToken(market, contract);
  const risk_label = getRiskLabel(score);
  const momentum   = computeMomentum(market);
  
  return {
    // Core identity
    mint: address,
    chain_id: chainId,
    chain: chainId === 8453 ? 'base' : 'ethereum',
    
    // Risk scoring (matches token-risk-service schema)
    score,
    risk_label,
    signals,
    
    // Market data
    price_usd:        market.price_usd,
    liquidity_usd:    market.liquidity_usd,
    volume_24h:       market.volume_24h,
    volume_6h:        market.volume_6h,
    volume_1h:        market.volume_1h,
    price_change_24h: market.price_change_24h,
    price_change_6h:  market.price_change_6h,
    price_change_1h:  market.price_change_1h,
    pair_count:       market.pair_count,
    primary_dex:      market.primary_dex,
    fdv:              market.fdv,
    age_hours:        market.age_hours,
    txns_24h:         market.txns_24h,
    buys_24h:         market.buys_24h,
    sells_24h:        market.sells_24h,
    buys_1h:          market.buys_1h,
    sells_1h:         market.sells_1h,
    
    // Momentum
    momentum_ratio: momentum,
    
    // Contract info
    is_verified:    contract.isVerified,
    holder_count:   contract.holderCount,
    contract_name:  contract.contractName || null,
    
    // Metadata
    fetched_at: new Date().toISOString(),
    source: 'evm-signal-adapter',
  };
}

/**
 * Batch score multiple EVM tokens.
 * 
 * @param {string[]} addresses - Array of EVM token addresses
 * @param {number} chainId
 * @returns {Promise<Object[]>} Array of risk signals
 */
export async function scoreEvmTokenBatch(addresses, chainId = 8453) {
  // Serialize to avoid rate limits on free tier APIs
  const results = [];
  for (const addr of addresses) {
    const result = await scoreEvmToken(addr, chainId);
    results.push(result);
    // Small delay between requests to be polite to free APIs
    await new Promise(r => setTimeout(r, 250));
  }
  return results;
}

/**
 * Check if a token meets trading criteria for the hackathon.
 * 
 * Mirrors grad-alert's momentum threshold logic but for EVM tokens.
 * 
 * @param {Object} signal - Output from scoreEvmToken()
 * @param {Object} opts   - { maxRisk, minMomentum, minLiquidity }
 * @returns {{ tradeable: boolean, reason: string }}
 */
export function evaluateTradeSignal(signal, opts = {}) {
  const {
    maxRisk     = 65,
    minMomentum = 2.0,
    minLiquidity = 10000,
  } = opts;
  
  if (signal.score > maxRisk) {
    return { tradeable: false, reason: `risk score ${signal.score} exceeds threshold ${maxRisk}` };
  }
  
  if (signal.liquidity_usd < minLiquidity) {
    return { tradeable: false, reason: `liquidity $${Math.round(signal.liquidity_usd)} below minimum $${minLiquidity}` };
  }
  
  if (signal.momentum_ratio !== null && signal.momentum_ratio < minMomentum) {
    return { tradeable: false, reason: `momentum ${signal.momentum_ratio}x below threshold ${minMomentum}x` };
  }
  
  // Reject unverified contracts (stricter on EVM where rug-pulls are common)
  if (signal.is_verified === false) {
    return { tradeable: false, reason: 'contract not verified on-chain' };
  }
  
  return {
    tradeable: true,
    reason: `risk ${signal.score}, liquidity $${Math.round(signal.liquidity_usd)}, momentum ${signal.momentum_ratio}x`,
  };
}

// ─── CLI test ─────────────────────────────────────────────────────────────────

// Run: node evm-signal-adapter.js <tokenAddress> [chainId]
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const addr    = process.argv[2];
  const chainId = parseInt(process.argv[3] || '8453');
  
  if (!addr) {
    console.error('Usage: node evm-signal-adapter.js <tokenAddress> [chainId]');
    console.error('Example: node evm-signal-adapter.js 0x4200000000000000000000000000000000000006 8453');
    process.exit(1);
  }
  
  console.log(`\n[evm-signal-adapter] Scoring ${addr} on chain ${chainId}...\n`);
  
  scoreEvmToken(addr, chainId).then(signal => {
    console.log('RISK SIGNAL:');
    console.log(JSON.stringify(signal, null, 2));
    
    const evaluation = evaluateTradeSignal(signal);
    console.log('\nTRADE EVALUATION:');
    console.log(`  tradeable: ${evaluation.tradeable}`);
    console.log(`  reason: ${evaluation.reason}`);
  }).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
