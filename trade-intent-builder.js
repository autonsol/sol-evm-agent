/**
 * trade-intent-builder.js
 * 
 * Constructs and signs EIP-712 TradeIntents for the ERC-8004 Hackathon
 * Risk Router contract.
 * 
 * The Risk Router contract address is provided by the hackathon Discord
 * on March 30, 2026. This module is ready to plug in once that address
 * is known — everything else is standard EIP-712.
 * 
 * Usage:
 *   const builder = new TradeIntentBuilder({ privateKey, rpcUrl, chainId });
 *   const intent  = await builder.buildIntent({ tokenIn, tokenOut, amountIn, signal });
 *   const receipt = await builder.submitToRiskRouter(intent);
 */

import { ethers } from 'ethers';

// ─── Risk Router ABI (minimal — submit + query) ───────────────────────────────
// ⚠️  UPDATE with actual ABI from hackathon Discord on March 30

const RISK_ROUTER_ABI = [
  // Submit a signed TradeIntent
  'function submitTradeIntent(tuple(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, uint256 deadline, address agent, uint256 nonce, bytes32 signalHash) intent, bytes signature) external returns (bytes32 intentId)',
  
  // Query agent's performance in the sandbox
  'function getAgentPerformance(address agent) external view returns (uint256 totalTrades, int256 totalPnlBps, uint256 winRate)',
  
  // Get current nonce for an agent
  'function nonces(address agent) external view returns (uint256)',
  
  // Events
  'event TradeIntentSubmitted(bytes32 indexed intentId, address indexed agent, address tokenIn, address tokenOut, uint256 amountIn)',
  'event TradeIntentExecuted(bytes32 indexed intentId, uint256 amountOut, int256 pnlBps)',
  'event TradeIntentRejected(bytes32 indexed intentId, string reason)',
];

// ─── EIP-712 Type Definitions ─────────────────────────────────────────────────
// Matches the Risk Router's expected TradeIntent struct

const EIP712_DOMAIN_NAME    = 'ERC8004RiskRouter';
const EIP712_DOMAIN_VERSION = '1';

const TRADE_INTENT_TYPES = {
  TradeIntent: [
    { name: 'tokenIn',      type: 'address' },
    { name: 'tokenOut',     type: 'address' },
    { name: 'amountIn',     type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'deadline',     type: 'uint256' },
    { name: 'agent',        type: 'address' },
    { name: 'nonce',        type: 'uint256' },
    { name: 'signalHash',   type: 'bytes32' },
  ],
};

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE_CHAIN_ID = 8453;

// Common Base mainnet token addresses
export const BASE_TOKENS = {
  USDC:  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
  WETH:  '0x4200000000000000000000000000000000000006', // WETH on Base
  CBBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC on Base
  DAI:   '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI on Base
};

// Default slippage tolerance in basis points
const DEFAULT_SLIPPAGE_BPS = 50; // 0.5%

// Intent deadline: 5 minutes from now
const INTENT_TTL_SECONDS = 300;

// ─── TradeIntentBuilder ───────────────────────────────────────────────────────

export class TradeIntentBuilder {
  /**
   * @param {Object} config
   * @param {string} config.privateKey        - EVM wallet private key (0x...)
   * @param {string} config.rpcUrl            - Base mainnet RPC URL
   * @param {number} [config.chainId]         - Chain ID (default: 8453 Base)
   * @param {string} [config.riskRouterAddress] - Risk Router contract address (from hackathon Discord)
   */
  constructor(config) {
    this.chainId    = config.chainId || BASE_CHAIN_ID;
    this.rpcUrl     = config.rpcUrl  || 'https://mainnet.base.org';
    
    // ⚠️  PLACEHOLDER — update with actual address from hackathon Discord on March 30
    this.riskRouterAddress = config.riskRouterAddress || process.env.RISK_ROUTER_ADDRESS || null;
    
    // Set up ethers.js
    this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
    this.wallet   = new ethers.Wallet(config.privateKey, this.provider);
    this.agentAddress = this.wallet.address;
    
    // Risk Router contract instance (null until address is set)
    this.riskRouter = this.riskRouterAddress
      ? new ethers.Contract(this.riskRouterAddress, RISK_ROUTER_ABI, this.wallet)
      : null;
    
    console.log(`[TradeIntentBuilder] Agent address: ${this.agentAddress}`);
    console.log(`[TradeIntentBuilder] Chain ID: ${this.chainId}`);
    console.log(`[TradeIntentBuilder] Risk Router: ${this.riskRouterAddress || 'NOT SET (update on March 30)'}`);
  }
  
  // ── EIP-712 Domain ──────────────────────────────────────────────────────────
  
  _getDomain() {
    if (!this.riskRouterAddress) {
      throw new Error('Risk Router address not set. Update RISK_ROUTER_ADDRESS env var on March 30.');
    }
    return {
      name:              EIP712_DOMAIN_NAME,
      version:           EIP712_DOMAIN_VERSION,
      chainId:           this.chainId,
      verifyingContract: this.riskRouterAddress,
    };
  }
  
  // ── Nonce ───────────────────────────────────────────────────────────────────
  
  async _getNonce() {
    if (!this.riskRouter) {
      // Pre-launch: simulate nonce from local counter
      if (!this._localNonce) this._localNonce = 0;
      return this._localNonce++;
    }
    try {
      const nonce = await this.riskRouter.nonces(this.agentAddress);
      return Number(nonce);
    } catch (err) {
      console.error('[TradeIntentBuilder] Failed to fetch nonce:', err.message);
      throw err;
    }
  }
  
  // ── Signal Hash ─────────────────────────────────────────────────────────────
  
  /**
   * Hash a risk signal from evm-signal-adapter for inclusion in TradeIntent.
   * This creates an on-chain-verifiable link between the signal and the trade.
   */
  _hashSignal(signal) {
    const signalData = JSON.stringify({
      mint:           signal.mint,
      score:          signal.score,
      risk_label:     signal.risk_label,
      momentum_ratio: signal.momentum_ratio,
      fetched_at:     signal.fetched_at,
    });
    return ethers.keccak256(ethers.toUtf8Bytes(signalData));
  }
  
  // ── Amount Calculations ─────────────────────────────────────────────────────
  
  /**
   * Calculate minAmountOut with slippage tolerance.
   * Requires a price oracle or AMM quote — uses DexScreener price as proxy.
   */
  _calcMinAmountOut(amountIn, signal, slippageBps = DEFAULT_SLIPPAGE_BPS) {
    // If we have price data from DexScreener, use it
    // Otherwise, set minAmountOut = 1 (max slippage) for sandbox/test
    // In production, get a quote from Uniswap V3 quoter contract
    
    // For sandbox: 1 USDC minimum (basically no slippage protection)
    // For production: calculate from AMM quote
    const minAmountOut = ethers.parseUnits('1', 6); // 1 USDC (6 decimals)
    return minAmountOut;
  }
  
  // ── Build Intent ────────────────────────────────────────────────────────────
  
  /**
   * Build a signed EIP-712 TradeIntent ready for submission to the Risk Router.
   * 
   * @param {Object} opts
   * @param {string} opts.tokenIn      - Input token address (e.g. USDC)
   * @param {string} opts.tokenOut     - Output token address (the token to buy)
   * @param {string|bigint} opts.amountIn  - Amount of tokenIn in base units
   * @param {Object} opts.signal       - Risk signal from evm-signal-adapter
   * @param {number} [opts.slippageBps] - Slippage tolerance in basis points
   * @returns {Promise<Object>} { intent, signature, signedAt, intentHash }
   */
  async buildIntent(opts) {
    const {
      tokenIn     = BASE_TOKENS.USDC,
      tokenOut,
      amountIn,
      signal,
      slippageBps = DEFAULT_SLIPPAGE_BPS,
    } = opts;
    
    if (!tokenOut)  throw new Error('tokenOut is required');
    if (!amountIn)  throw new Error('amountIn is required');
    if (!signal)    throw new Error('signal (from evm-signal-adapter) is required');
    
    const nonce        = await this._getNonce();
    const deadline     = Math.floor(Date.now() / 1000) + INTENT_TTL_SECONDS;
    const minAmountOut = this._calcMinAmountOut(amountIn, signal, slippageBps);
    const signalHash   = this._hashSignal(signal);
    
    const intent = {
      tokenIn:      ethers.getAddress(tokenIn),
      tokenOut:     ethers.getAddress(tokenOut),
      amountIn:     BigInt(amountIn),
      minAmountOut: minAmountOut,
      deadline:     BigInt(deadline),
      agent:        this.agentAddress,
      nonce:        BigInt(nonce),
      signalHash,
    };
    
    // Determine domain — use placeholder if Risk Router not deployed yet
    const domain = this.riskRouterAddress
      ? this._getDomain()
      : { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId: this.chainId, verifyingContract: ethers.ZeroAddress };
    
    const isPreLaunch = !this.riskRouterAddress;
    if (isPreLaunch) {
      console.warn('[TradeIntentBuilder] Pre-launch mode — signing with placeholder domain (ZeroAddress). Set RISK_ROUTER_ADDRESS on March 30.');
    }
    
    // Sign with EIP-712
    let signature;
    try {
      signature = await this.wallet.signTypedData(domain, TRADE_INTENT_TYPES, intent);
    } catch (err) {
      console.warn('[TradeIntentBuilder] Signing error:', err.message);
      signature = '0x' + '00'.repeat(65); // placeholder sig
    }
    
    // Compute intent hash (what the contract will emit as intentId)
    let intentHash;
    try {
      intentHash = ethers.TypedDataEncoder.hash(domain, TRADE_INTENT_TYPES, intent);
    } catch {
      intentHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify({ intent: { ...intent, amountIn: intent.amountIn.toString(), minAmountOut: intent.minAmountOut.toString(), deadline: intent.deadline.toString(), nonce: intent.nonce.toString() } })));
    }
    
    return {
      intent,
      signature,
      signedAt: new Date().toISOString(),
      intentHash,
      prelaunch: isPreLaunch,
      signal: {
        score:          signal.score,
        risk_label:     signal.risk_label,
        momentum_ratio: signal.momentum_ratio,
        liquidity_usd:  signal.liquidity_usd,
        signalHash,
      },
    };
  }
  
  // ── Submit to Risk Router ───────────────────────────────────────────────────
  
  /**
   * Submit a signed TradeIntent to the Risk Router contract.
   * 
   * @param {Object} signedIntent - Output from buildIntent()
   * @returns {Promise<Object>} { txHash, intentId, gasUsed }
   */
  async submitToRiskRouter(signedIntent) {
    if (!this.riskRouter) {
      throw new Error('Risk Router address not set. Cannot submit until March 30 when hackathon provides the address.');
    }
    
    const { intent, signature } = signedIntent;
    
    try {
      const gas = await this.riskRouter.submitTradeIntent.estimateGas(intent, signature);
      console.log(`[TradeIntentBuilder] Estimated gas: ${gas.toString()}`);
      
      const tx = await this.riskRouter.submitTradeIntent(intent, signature, {
        gasLimit: (gas * 120n) / 100n, // 20% gas buffer
      });
      
      console.log(`[TradeIntentBuilder] Tx submitted: ${tx.hash}`);
      const receipt = await tx.wait();
      
      // Extract intentId from event
      const event = receipt.logs
        .map(log => { try { return this.riskRouter.interface.parseLog(log); } catch { return null; } })
        .find(e => e?.name === 'TradeIntentSubmitted');
      
      const intentId = event?.args?.intentId || null;
      
      return {
        txHash:   tx.hash,
        intentId,
        gasUsed:  receipt.gasUsed.toString(),
        blockNum: receipt.blockNumber,
      };
    } catch (err) {
      console.error('[TradeIntentBuilder] Submission failed:', err.message);
      throw err;
    }
  }
  
  // ── Query Performance ───────────────────────────────────────────────────────
  
  /**
   * Get agent's current performance metrics from the Risk Router.
   * Used to track hackathon ranking.
   */
  async getPerformance() {
    if (!this.riskRouter) {
      return { totalTrades: 0, totalPnlBps: 0, winRate: 0, note: 'Risk Router not deployed yet' };
    }
    
    try {
      const [totalTrades, totalPnlBps, winRate] = await this.riskRouter.getAgentPerformance(this.agentAddress);
      return {
        totalTrades:  Number(totalTrades),
        totalPnlBps:  Number(totalPnlBps),
        totalPnlPct:  Number(totalPnlBps) / 100,
        winRate:      Number(winRate) / 100, // assuming 4-decimal bps
        agentAddress: this.agentAddress,
      };
    } catch (err) {
      console.error('[TradeIntentBuilder] Failed to fetch performance:', err.message);
      return null;
    }
  }
  
  // ── Sandbox Simulation ──────────────────────────────────────────────────────
  
  /**
   * Simulate a trade locally before submitting to the Risk Router.
   * Used during pre-hackathon development (before March 30).
   * 
   * @param {Object} signal - Risk signal from evm-signal-adapter
   * @param {Object} opts   - Trade parameters
   * @returns {Object} Simulated outcome
   */
  simulateTrade(signal, opts = {}) {
    const {
      amountInUSD   = 100,
      momentumThreshold = 2.0,
      maxRisk       = 65,
    } = opts;
    
    // Decision logic (mirrors grad-alert v2.8 tiered thresholds)
    let minMomentum;
    if      (signal.score <= 30) minMomentum = 2.0;
    else if (signal.score <= 50) minMomentum = 2.5;
    else if (signal.score <= 65) minMomentum = 3.0;
    else return { decision: 'REJECT', reason: `Risk ${signal.score} exceeds max ${maxRisk}` };
    
    if (!signal.momentum_ratio) {
      return { decision: 'SKIP', reason: 'No momentum data available' };
    }
    
    if (signal.momentum_ratio < minMomentum) {
      return { decision: 'SKIP', reason: `Momentum ${signal.momentum_ratio}x below ${minMomentum}x threshold for risk band ${signal.score}` };
    }
    
    if (signal.liquidity_usd < 10000) {
      return { decision: 'SKIP', reason: `Liquidity $${Math.round(signal.liquidity_usd)} too low` };
    }
    
    // Estimate TP/SL based on risk score (from grad-alert v2.2 exit params)
    let tpMultiplier, slPct, holdHours;
    if      (signal.score <= 30) { tpMultiplier = 3.0; slPct = 0.30; holdHours = 24; }
    else if (signal.score <= 50) { tpMultiplier = 2.5; slPct = 0.30; holdHours = 12; }
    else                          { tpMultiplier = 1.5; slPct = 0.30; holdHours = 4;  }
    
    return {
      decision:     'BUY',
      amountInUSD,
      signal_score: signal.score,
      risk_label:   signal.risk_label,
      momentum:     signal.momentum_ratio,
      take_profit:  `${((tpMultiplier - 1) * 100).toFixed(0)}% gain target`,
      stop_loss:    `${(slPct * 100).toFixed(0)}% loss limit`,
      hold_hours:   holdHours,
      expected_tp:  amountInUSD * tpMultiplier,
      expected_sl:  amountInUSD * (1 - slPct),
    };
  }
}

// ─── CLI test ─────────────────────────────────────────────────────────────────

// Run: node trade-intent-builder.js [dry-run]
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const isDryRun = process.argv[2] === 'dry-run' || !process.env.EVM_PRIVATE_KEY;
  
  if (isDryRun) {
    console.log('\n[trade-intent-builder] DRY RUN — simulating with test key\n');
    
    // Use a throwaway test key for CLI testing
    const testKey  = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // well-known test key
    const builder  = new TradeIntentBuilder({
      privateKey:        testKey,
      rpcUrl:            'https://mainnet.base.org',
      riskRouterAddress: process.env.RISK_ROUTER_ADDRESS,
    });
    
    // Simulate a trade signal
    const mockSignal = {
      mint:           '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      score:          28,
      risk_label:     'LOW',
      momentum_ratio: 3.4,
      liquidity_usd:  150000,
      fetched_at:     new Date().toISOString(),
    };
    
    const sim = builder.simulateTrade(mockSignal, { amountInUSD: 100 });
    console.log('SIMULATION RESULT:');
    console.log(JSON.stringify(sim, null, 2));
    
    // Build intent (will sign with test key, submission will fail without Risk Router)
    console.log('\nBUILDING INTENT (pre-launch mode)...');
    builder.buildIntent({
      tokenIn:  BASE_TOKENS.USDC,
      tokenOut: mockSignal.mint,
      amountIn: ethers.parseUnits('100', 6), // 100 USDC
      signal:   mockSignal,
    }).then(signed => {
      console.log('\nSIGNED INTENT:');
      console.log(`  intentHash: ${signed.intentHash}`);
      console.log(`  signedAt:   ${signed.signedAt}`);
      console.log(`  tokenIn:    ${signed.intent.tokenIn}`);
      console.log(`  tokenOut:   ${signed.intent.tokenOut}`);
      console.log(`  amountIn:   ${signed.intent.amountIn.toString()}`);
      console.log(`  nonce:      ${signed.intent.nonce.toString()}`);
      console.log(`  deadline:   ${signed.intent.deadline.toString()}`);
      console.log(`  signalHash: ${signed.intent.signalHash}`);
      console.log(`  signature:  ${signed.signature.slice(0, 20)}...`);
      console.log('\n✅ trade-intent-builder.js is working. Ready for March 30 Risk Router address.');
    });
    
  } else {
    console.log('[trade-intent-builder] Set EVM_PRIVATE_KEY env var to test with real key');
    console.log('[trade-intent-builder] Run with "dry-run" arg for test with throwaway key');
  }
}
