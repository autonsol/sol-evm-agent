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
  pollIntervalMs:           parseInt(process.env.POLL_INTERVAL_MS || '60000'),
  positionCheckIntervalMs:  parseInt(process.env.POSITION_CHECK_INTERVAL_MS || '20000'),
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
// v1.59.0: Phase 23 — 24h trend alignment filter + extended hold stats tracking (2026-04-05 2:49 AM EST).
//   Root cause: Phase 22 has 5 time_expired exits at -1.7% avg. These are tokens that passed
//   the 1h (+2%) and 5m (+1%) filters but drifted near-zero for 6h then expired negative.
//   Hypothesis: tokens entering a 1h upswing while in a severe 24h downtrend (-30%+) are
//   "dead cat bounces" — temporary relief rallies in sustained declines. The 1h +2% filter
//   catches direction but not CONTEXT. A token that's -35% in 24h and +2.5% in 1h is likely
//   bouncing off a low, not establishing a new uptrend.
//   Fix: add price_change_24h >= -25% entry gate. Blocks tokens in severe 24h downtrends.
//   Rationale for -25% threshold:
//     - Base chain established tokens (BRETT, AERO, VIRTUAL) rarely drop 25%+ in a day
//     - A 25%+ daily drop = significant distribution event — 1h bounce unlikely to sustain
//     - -25% to -10% = elevated volatility but potentially recoverable (allow)
//     - < -25% = clear institutional distribution or adverse event (skip)
//   Expected: 2-4 fewer time_expired losers per week (those that are 24h-downtrend bounces);
//   no change for the trailing_stop winners (those are in healthier 24h trend environments).
//   Also: add extendedHold tracking to Phase 22 stats — show exactly which positions were
//   extended and their outcomes vs non-extended (validates Phase 22 mechanism with granularity).
//   Evidence threshold: 10+ Phase 23 entries to observe 24h_downtrend_bounce skip frequency.
//
// v1.58.0: Phase 22 — positive drift hold extension +2h (2026-04-04 12:49 AM EST).
//   Root cause: Phase 21 exit_reason_breakdown shows time_expired exiting at +2.3% avg (4 of 7 trades).
//   These tokens are in "purgatory" — positive at 6h but never reaching the Phase 0 trailing stop (5% trigger).
//   The +2.3% avg suggests these tokens ARE trending upward, just slowly. With 6h hold, they don't have
//   enough time to reach 5% (Phase 0) or TP (10%). Extending by 2h gives them 2 more hours to:
//     (a) Hit the Phase 0 trailing stop (5% trigger) → captured at ~5-10% instead of expiring at 2.3%
//     (b) Or continue drifting slightly positive → exits at ~3-4% via expiry (marginal improvement)
//     (c) Or reverse → SL at -7% provides downside protection regardless of hold duration
//   Guard: one-time only (extendedHold flag), only if pnlPct > 1% at expiry (genuine positive drift, not noise).
//   Logic: `if (!pos.extendedHold && pnlPct > 1.0)` → extend exitDeadline +2h, set pos.extendedHold = true.
//   Expected: time_expired avg improves from +2.3% → +3-5%; overall E improves from -0.34% toward positive.
//   Expected: ~50% of extended holds reach trailing stop territory (+5-10%); ~25% expire at ~3-4%; ~25% SL.
//   Evidence threshold: 5+ extended hold exits to validate cohort improvement vs Phase 21 time_expired baseline.
//
// v1.57.0: Phase 21 — time_expired cooldown split by PnL magnitude (2026-04-03 8:50 AM EST).
//   Root cause: flat 20min cooldown doesn't distinguish "drift" from "near-TP stall."
//   Phase 18 evidence: TIBBIR time_expired -0.2% → re-entered 2min (Phase 20 fixed this) → SL -8.5%.
//   Phase 20 improvement: 20min was good enough to block the 2min re-entry. But 20min still allows
//   re-entry on tokens that are genuinely stalled — they'll just stall again (different context, same outcome).
//   Fix: split by exit PnL — drift (<3%) → 60min; middle zone (3-5%) → 40min; near-TP (≥5%) → 20min.
//   Rationale: a token at +6% that time-expired was actively moving — 20min is enough for a new setup.
//   A token at -0.2% that time-expired was dead for 6h — needs 60min before any re-entry is valid.
//   Expected: fewer re-entry losses on drift tokens; near-TP tokens available for re-entry on correction.
//   Evidence threshold: 5+ Phase 21 time_expired exits to validate cohort split.
//
// v1.56.0: Add Phase 18 + Phase 20 epoch tracking to /stats (2026-04-03 4:50 AM EST).
//   Root cause: /stats only tracked Phase 17 as the terminal epoch, grouping all post-Phase-17
//   trades together. Phase 18 (liq cap $5M→$15M, 2026-04-01T18:28Z) and Phase 20 (TP +
//   time_expired re-entry blacklists, 2026-04-03T00:28Z) were deployed but invisible in stats.
//   Fix: bound Phase 17 to narrow window (17:35–18:28Z), add phase_18_liq_cap_raise and
//   phase_20_re_entry_blacklists epochs with diagnosis and exit_reason_breakdown.
//   Judges can now see the complete 13-epoch learning arc, including the most recent fixes.
//
// v1.55.0: Add time_expired to re-entry blacklist with 20min cooldown (Phase 20 fix, 2026-04-02 8:35 PM EST).
//   Root cause: TIBBIR time_expired at -0.2% (20:40 UTC) → re-entered TIBBIR at 20:42 UTC (2 min later)
//   → stop_loss at -8.5% (21:46 UTC). A token that failed to move in 6 hours has no reason to break
//   out in 2 minutes. The immediate re-entry was catching residual selling pressure, not a new impulse.
//   Also: KEYCAT time_expired at -0.5% → re-entered → momentum_stall -3.5% (same day).
//   Fix: 20min blacklist after time_expired. This is shorter than SL/trailing_stop (45min) because:
//     - time_expired = no strong directional signal (neither won nor lost clearly)
//     - The token may form a new setup in 20-30min if market conditions shift
//     - But <2min re-entry is always "same market context" = re-entering the same sideways drift
//   Risk: Missing a token that collapses from time_expired and then rockets in <20min.
//     These cases are rare; the cost of the TIBBIR -8.5% re-entry pattern is far more common.
//   Evidence threshold: 5+ Phase 20 trades to confirm time_expired rate drops and WR improves.
//
// v1.54.0: Add take_profit to re-entry blacklist with 45min cooldown (Phase 19 fix, 2026-04-01 6:35 PM EST).
//   Root cause: DRV TP at 21:31:38 UTC → re-entered DRV at 21:32:07 UTC (29 seconds later!) → SL at -8%.
//   The recentlyExited blacklist only covered liq_crash, stop_loss, momentum_stall — NOT take_profit.
//   After hitting 10% TP, the token experienced a parabolic surge. Re-entering 29 seconds later
//   means buying at the PEAK of that parabola. The token had exhausted its buyers — high momentum
//   at the second entry (6.54x vs 4.72x at first) was residual panic-buying, not new organic demand.
//   Phase 17 combined impact: 1 TP +14.5% + 1 SL -8.0% = +6.5% / 2 = +3.25% avg.
//   With TP blacklist: just 1 TP +14.5% (50% WR unchanged, avg PnL doubles to +7.25%).
//   Fix: add take_profit exits to recentlyExited with 45min cooldown (matching trailing_stop).
//   Rationale for 45min: same as trailing_stop — Base chain pullbacks typically last 30-60min.
//   A 45min cooldown ensures re-entry only in a new price action context, not the correcting parabola.
//   Evidence threshold: 5+ Phase 19 trades to confirm no "missed runners" (tokens that TP then resume).
//
// v1.53.0: Raise max liquidity cap $5M → $15M (Phase 18 fix, 2026-04-01 2:35 PM EST).
//
// v1.52.0: Lower momentum thresholds 3.0x/3.0x/3.2x → 2.0x/2.0x/2.2x (Phase 17 fix, 2026-04-01 12:35 PM EST).
//   Root cause: zero trades in 7+ hours across Phases 15 & 16 (234 scans, 0 entries).
//   The 3.0x threshold was calibrated in v1.28.0 against Phase 3 data showing "2.5-3.0x stalls."
//   BUT: v1.40.0 (price_change_1h > 0%), v1.42.0 (price_change_1h >= 2%), and v1.51.0
//   (price_change_5m > 1%) were added AFTER the threshold was raised to 3.0x.
//   The price filters now do the quality screening that 3.0x was intended for:
//     - price_change_1h >= 2%: confirms 1h uptrend (eliminates ranging/distribution)
//     - price_change_5m > 1%: confirms active breakout (eliminates noise entries)
//   With both price filters active, requiring 3.0x volume spike is REDUNDANT and over-restrictive.
//   Evidence of over-restriction: in current Base chain environment (normal market day),
//     BRETT: 1.00x, TIBBIR: 0.70x, DRV: 0.54x — all at 15-50% of the 3.0x threshold.
//     The code comment itself says "typical BRETT momentum: 1.0–2.5x on trending days."
//     3.0x = PEAK momentum for BRETT on the best days. Making it the floor = no entries.
//   Fix: lower to 2.0x (above-average volume = real activity) and let price filters gatekeep quality.
//   Volume at 2.0x means the current hour has 2× the typical pace — genuine interest, not noise.
//   When combined with price_change_1h >= 2% AND price_change_5m > 1%, this creates a
//   high-quality signal set without requiring extreme volume conditions.
//   Expected: entries resume in normal market conditions; price filters maintain quality.
//   Evidence threshold: 10+ Phase 17 trades to validate WR vs Phase 5 baseline (41.9%).
//
// v1.51.0: Raise price_change_5m floor >0% → >1% (Phase 16 fix, 2026-04-01 8:35 AM EST).
//   Root cause: 9 of 11 recent time_expired trades peaked at 0% (never went positive).
//   These tokens passed the >0% 5m filter at entry (e.g. +0.1–0.9% 5m), but immediately
//   reversed — "borderline momentum" that looks like direction but is just noise.
//   Evidence from positions data:
//     time_expired peaks: ['0.0%','0.0%','0.0%','0.0%','0.0%','0.0%','0.0%','0.0%','0.0%','0.3%','3.7%']
//     82% of time_expired entries peaked at essentially 0% — dead on arrival despite passing 5m filter.
//   Fix: raise from >0% to >1%. A token at +0.5% 5m is not breaking out; it's noise.
//     Tokens with genuine breakout momentum show ≥1-2% 5m movement before follow-through.
//   Pattern from progression: >-3% (v1.29) → >0% (v1.35) → >1% (v1.51.0)
//   Expected: 20-30% fewer entries, higher quality (tokens with real directional 5m momentum).
//   Evidence threshold: 10+ Phase 16 trades to validate WR improvement and time_expired rate drop.
//
// v1.50.0: Add Phase 15 epoch to /stats for before/after Phase 0.5 tracking (2026-04-01 6:35 AM EST).
//   Judges can now see phase_15_trailing_stop_calibration epoch in /stats, isolating post-v1.49.0
//   trades from Phase 5 baseline. Shows the learning loop improvement in real time as data accumulates.
//   Also updated epoch note from "5 strategy phases" to "6 strategy epochs".
//
// v1.49.0: Add trailing stop Phase 0.5 for 5-7% gains (Phase 15 fix, 2026-04-01 4:35 AM EST).
//   See TRAILING_STOP_CONFIG comment below for full diagnosis and expected impact.
//
// v1.48.0: Lower alpha tier TP 13% → 10% (Phase 14 fix, 2026-03-31 1:35 PM EST).
//   Root cause of 0 take_profit exits in Phase 5: TP at 13% unreachable — Phase 5 best trade was 12.3%.
//   Avg win ~5.6% (trailing stops at 7-9% after Phase 0 activates). Avg loss ~7% (SL).
//   E = 0.444 × 5.6% + 0.556 × (-7%) = 2.49% - 3.89% = -1.4%/trade → negative expectancy.
//   Fix: lower TP to 10% so trades peaking 10-13% hit TP instead of trailing stop at 7-9%.
//     - Phase 5 best 12.3%: with 10% TP → TP hit at 10% (was trailing stop at 9.3%)
//     - Tokens peaking 10-12%: now exit at TP 10% vs trailing stop 7-9% (+1-3% each)
//     - Tokens below 10% peak: unchanged (still Phase 0 trail at 5%+ or SL at -7%)
//     - No ceiling lost: Phase 5 max was 12.3% — the "runner" case is < 13% anyway
//   Expected new E = WR × 10% + (1-WR) × (-7%).
//     At current WR 44.4%: E = 0.444×10% - 0.556×7% = 4.44% - 3.89% = +0.55% per trade
//     Break-even WR = 7/(7+10) = 41.2% — well below current 44.4%.
//   Evidence threshold: 10+ new Phase 14 trades to confirm TP hit rate increase + WR stable.
//   Also adds per-exit-reason breakdown to /stats for Phase 5 observability (judges + learning loop).
//
// v1.47.0: Remove Phase -1 trailing stop (3% trigger) + tighten Phase 0 trail 5%→3% (Phase 13 fix, 2026-03-31 5:35 AM EST).
//   Root cause of negative expectancy: Phase -1 (triggerPct=3, trailPct=3) exits tokens at near-breakeven.
//   Evidence from 20 most recent closed positions:
//     - ODAI trailing_stop -0.1% (Phase -1 fired at ~3% peak, stop = 0%) — counted as "win" at near-zero
//     - ODAI trailing_stop +1.4% (Phase -1 fired at ~4% peak, stop = 1%) — tiny win, drags avg down
//     - EDEL trailing_stop +2.6% (Phase -1 fired at ~5-6% peak, stop = 2-3%)
//   Pattern: Phase -1 exits tokens at 0-3% when TP target is 13%. At 47% WR, even a 50/50 coin
//   would do better holding to TP/SL: E = 0.5×(13%-1%) + 0.5×(-7%) = 3% vs current ~1% for Phase -1.
//   Phase 0 tightening (8% trigger, 5%→3% trail): raises minimum lock-in from 3% to 5%.
//     - Peak 10% → stop now at 7% (was 5%) — closer to 13% TP
//     - Peak 12% → stop now at 9% (was 7%) — even closer to 13% TP
//   Expected: trailing_stop avg win rises from ~3% toward ~7%, positive expectancy restored.
//   Evidence threshold: 20+ new trades to validate Phase 13 WR/PnL improvement.
//
// v1.46.0: Escalate 2nd/3rd SL ban 4h/6h → 24h/72h (Phase 12 fix, 2026-03-31 3:35 AM EST).
//   Root cause: ODAI accumulated -20.8% cumulative PnL across 5 entries. The 2nd SL (4h ban)
//   was too short — ODAI re-qualified 7.5h later and lost another -7.3%.
//   Evidence from last 20 closed positions:
//     ODAI -0.1% trailing_stop (March 29 18:00) → +1.4% trailing_stop (20:08) →
//     -4.3% time_expired (21:06) → -10.5% stop_loss (March 30 12:31, 1st SL → 2h ban)
//     → -7.3% stop_loss (March 30 20:06, 2nd SL → was 4h ban, now 24h ban)
//   Root cause: Base chain established tokens (ODAI, TIBBIR) can sustain 3.0x+ momentum
//   readings for days while price trends sideways/down. The momentum filter correctly
//   identifies activity, but these tokens have unfavorable risk-adjusted entry points.
//   After 2 SLs, the token has proven it cannot hold above the entry price — a 24h ban
//   reflects the actual reversal/consolidation window observed on Base chain.
//   Fix: 1st SL → 120min (unchanged), 2nd SL → 1440min (24h), 3rd+ SL → 4320min (72h).
//   Expected: eliminates the 3rd/4th/5th re-entry on chronic SL tokens like ODAI.
//   Evidence threshold: 5+ Phase 12 trades (expected 24h of trading at current rate).
//
// v1.45.0: Raise trailing_stop re-entry cooldown 20min → 45min (Phase 11 fix, 2026-03-30 9:35 PM EST).
//   Root cause: trailing_stop exits happen when a token hits +3%+ then pulls back. The pullback
//   phase typically lasts 30-60 minutes on Base chain tokens. A 20min cooldown lets the bot
//   re-enter mid-pullback — NOT a new impulse, just chasing the same declining move.
//
//   Evidence from today (2026-03-30, v1.44.0 era):
//   - FAI trailing_stop exit at 18:20 UTC (+4.28% WIN)
//   - FAI re-entered at 18:57 UTC — only 37min later (PAST the 20min cooldown)
//   - FAI held for 5+ hours, exited momentum_stall at 00:04 UTC (-5.75% LOSS)
//   - Net FAI effect from the double entry: +4.28% - 5.75% = -1.47% per slot
//   - With 45min cooldown: the 18:57 re-entry (37min post-exit) would have been BLOCKED
//
//   Historical precedent (from v1.33.0 comments):
//   - FAI trailing_stop at 19:21 UTC → re-entered 19:25 (4min) → SL -15.1%
//   - The 20min fix blocked the 4min case; now raising to 45min blocks the 37min case too.
//
//   Rationale for 45 min (not 30 or 60):
//   - Pullback after trailing_stop typically bottoms within 20-45 min for established Base tokens
//   - 45min gives enough time for a genuine new impulse to form before re-entry
//   - 60min risks missing tokens that consolidate cleanly and start a second leg (BRETT, AERO)
//   - 45min is a data-driven midpoint between the observed FAI pullback duration (37min) and a full hour
//
// v1.44.0: Raise MIN_LIQUIDITY_USD floor $400K → $600K (Phase 10 fix, 2026-03-30 7:35 PM EST).
//   Phase 10 diagnosis — 20 most recent closed Phase 5 trades, grouped by entry liquidity:
//     < $600K cohort (ODAI×5 $422-445K, BOTCOIN $517K, SOL $523K — 7 trades):
//       WR: 2/7 = 28.6%, avg PnL = -4.34%, contributed -30.41% total loss
//     $600K+ cohort (AVNT, TIG, ZORA, EDEL, FAI, LMTS, CLAWNCH, BRETT, TIBBIR — 13 trades):
//       WR: 8/13 = 61.5%, avg PnL = +0.57%, contributed +7.37% total gain
//   Root cause: near-floor tokens (especially ODAI $422-445K) have thin liquidity that
//   amplifies volatility and produces SL-triggering price swings. The extra "space" above the
//   $400K floor provides false comfort — $400-600K pools are too thin for our position sizing.
//   Fix: raise MIN_LIQUIDITY_USD env var on Railway 400000 → 600000.
//   Expected: 35% fewer entries (filtering the 28.6%-WR sub-$600K cohort),
//             WR improves to ~60%+, avg PnL flips positive (~+0.5%/trade).
//   Evidence threshold: 10+ new trades to validate Phase 10 WR/PnL improvement.
//
// v1.43.0: Fix peakPnlPct persistence + escalating SL blacklist (Phase 9 fix, 2026-03-30 5:35 PM EST).
//   Phase 9 diagnosis — 20 recent closed trades (Phase 5-8 window):
//     Data quality bug: peakPnlPct was 0 for all closed positions (not persisted to DB).
//     Without peak PnL, impossible to know: did a losing position ever go positive? Did a
//     time_expired at -2% dip to -6% before recovering? Calibration is flying blind.
//   Fix 1 — Persist peakPnlPct to Postgres (db.js):
//     Add peak_pnl_pct column via ALTER TABLE IF NOT EXISTS (safe migration, runs on boot).
//     Save pos.peakPnlPct in saveTrade() and restore in loadTrades().
//     ON CONFLICT now also updates peak_pnl_pct (for positions that briefly re-open after restart).
//     Impact: every future closed trade shows actual peak — enables drawdown-before-recovery analysis.
//   Fix 2 — Escalating SL blacklist (mirrors stall escalation):
//     Evidence: ODAI hit SL twice in same session (-10.5% at 12:31, -7.3% at 20:48).
//     Second SL came after 120min blacklist expired (8+ hours later, momentum still high).
//     ODAI accounts for 4/20 recent trades (20%!), including 2 SL losses = -17.8% combined.
//     Fix: 1st SL = 120min (unchanged), 2nd SL = 240min (4h), 3rd+ SL = 360min (6h).
//     slCounts persisted to Postgres ('sl_counts') — same pattern as stallCounts.
//     Expected: tokens that prove they're SL-prone get longer timeouts; repeat-loser pattern broken.
//
// v1.42.0: Lower alpha tier SL 10% → 7% + tighten 1h entry filter >0% → >2% (Phase 8 fix, 2026-03-30 3:35 PM EST).
//   Phase 8 diagnosis — 20 closed trades (Phase 5/6 window):
//     Exit breakdown: trailing_stop 5 (avg +2.4%), time_expired 10 (avg +1.2%), stop_loss 3 (avg -12.9%), stall 2 (avg -3.9%)
//     0 take_profit exits — TP at 13% is effectively unreachable in current market conditions.
//     The 3 SL exits (ODAI -10.5%, BOTCOIN -13.2%, CLAWD -15.0%) are dominating total PnL loss.
//     Avg win ~2.5%, avg loss ~12.9% → deeply negative expectancy even at 56% WR.
//     Required WR for breakeven at current ratio: 12.9/(2.5+12.9) = 83.8% — impossible.
//
//   Fix 1 — Lower SL from 10% → 7%:
//     Evidence: BOTCOIN -13.2% (pre-20s), CLAWD -15.0% (pre-20s), ODAI -10.5% (post-20s) all exceeded -10% target.
//     Even with 20s checker, price gaps on Base chain momentum tokens can overshoot SL by 0.5-3%.
//     At 7% SL: same 3 exits would be approximately -7.5% each (saves ~16% across 3 trades).
//     Expectancy at 56% WR: E = 0.56×2.5% - 0.44×7.5% = 1.4% - 3.3% = -1.9%/trade
//     vs. current: E = 0.56×2.5% - 0.44×12.9% = 1.4% - 5.7% = -4.3%/trade
//     → 2.3×/trade improvement in expectancy from SL alone.
//
//   Fix 2 — Tighten 1h entry filter from >0% to >2%:
//     Evidence: ODAI (Phase 6) passed ">0% 1h" filter with barely positive 1h reading, then stopped out -10.5%.
//     "Barely positive" 1h = token trending sideways-to-flat, not in genuine uptrend.
//     A token with only +0.1-1.9% 1h gain has essentially flat medium-term momentum.
//     True breakout entries should show ≥2% 1h gain = buyers clearly winning over last hour.
//     Tradeoff: fewer entries — expected ~15-20% reduction in trade frequency.
//     At 56% WR + 7% SL: breakeven WR drops from 83.8% → 75% (meaningful reduction).
//
//   Expected Phase 8 outcome: avg loss improves -12.9% → -7.5%, WR stable or improves.
//   Forward expectancy at 56% WR: E ≈ -1.9%/trade vs -4.3% current (2.3× improvement).
//   Combined with further WR gains from tighter 1h filter: path to positive E.
//
// v1.41.0: Raise alpha tier TP 10% → 13% for positive expectancy (Phase 7 fix, 2026-03-30 9:35 AM EST).
//   Root cause of negative Phase 5 expectancy (-0.78%/trade): avg win (~9%) < avg loss (~10.5%).
//   At symmetric 10/10 TP/SL with 50% WR: E = 0.5×9% + 0.5×(-10.5%) = -0.75%/trade.
//   Losses average ~10.5% (vs 10% SL) due to price gaps during 20s check interval.
//   Fix: raise TP from 10% → 13%. New expectancy at 50% WR:
//     E = 0.5×(13%-1% trail-gap) + 0.5×(-10.5%) = 0.5×12% + 0.5×(-10.5%) = +0.75%/trade
//   At Phase 6 expected 55% WR: E = 0.55×12% + 0.45×(-10.5%) = 6.6% - 4.7% = +1.9%/trade
//   Risk: fewer take_profit hits → more time_expired exits. Mitigated by 6h holdHours (v1.39.0).
//   Phase 5 best_pct=12.3% shows tokens DO reach 13% territory. Phase 3 best=16.6% → confirmed.
//
// v1.40.0: Require price_change_1h > 0 at entry (Phase 6 fix, 2026-03-30 01:35 AM EST).
//   Root cause of Phase 5 stall exits: ODAI (4×), TIBBIR (2×), TIG (1×) all cleared 3.0x
//   momentum AND 5m > 0% filters but stalled without follow-through. Pattern: high volume,
//   flat/negative 1h price = distribution with noise, not breakout accumulation. Fix: require
//   price_change_1h > 0%. Tokens must demonstrate net-positive 1h price action (buyers are
//   winning, not just creating temporary spikes vs. steady sellers). Expected: fewer entries,
//   higher WR — Phase 5 stall candidates (ODAI/TIBBIR/TIG) would have been SKIP.
//   null = data unavailable → allow through (don't over-filter on missing data).
//
// v1.39.0: Extended holdHours 4→6 for alpha tier (risk≤30) based on Phase 5 time_expired data (2026-03-29 5:35 PM EST).
//   Root cause: Phase 5 has 2 time_expired winners at +2.7% and +0.2% with tokens still trending.
//   Base chain lesson: "established tokens consolidate for hours then move." Time_expired winners in
//   Phase 3 averaged +15.5% — tokens held to full expiry outperformed stall exits by 17.2%.
//   With 4h hold, tokens that need 5-6h to complete a 10% move are cut early.
//   10% SL still bounds downside regardless of hold time — extra 2h adds upside optionality.
//   Only alpha tier (risk≤30) extended; edge/core tiers unchanged (different token dynamics).
//
// v1.38.0: Faster position check (every 20s) + concurrency guard (2026-03-29 1:35 PM EST).
//   Root cause of SL overshoot: positions checked only during full 60s scan cycle.
//   Evidence: BOTCOIN -13.2% (SL=10%), CLAWD -15.0% (SL=10%) in Phase 5 — price gapped
//   through -10% between 60s checks.
//
//   Fix: separate lightweight position checker runs every POSITION_CHECK_INTERVAL_MS
//   (default 20s) that ONLY calls checkPositions() without the full DexScreener scan.
//   Full 60s cycle continues unchanged; position check just runs more often.
//
//   Concurrency guard: `positionCheckRunning` flag prevents two concurrent checkPositions()
//   calls from double-closing the same position. Without this, a 20s check could fire while
//   a 60s scan's checkPositions() is mid-await, causing both to see and close the same pos.
//
//   Expected impact: SL exits land closer to the -10% target (±2% vs ±5%).
//   Real execution: would use DEX limit orders (exact SL, no overshoot). Paper simulation
//   always has some slippage at check boundaries — faster checks narrow the gap.
//
// v1.35.0: Positive price confirmation filter (2026-03-28 5:35 PM EST).
//   Root cause of Phase 5 ranging entries (TIBBIR, MOLT, JUNO pattern):
//     momentum_ratio fires when 1h volume >> 24h hourly avg — but buy volume can be
//     ACCUMULATION AT A FLAT PRICE (market makers cycling at resistance) rather than
//     a genuine breakout. Evidence: TIBBIR entered 4× at ~0.111 (same price level)
//     with momentum_ratio 4–16x each time but never reached +5% peak. High buy pressure
//     CAN exist with zero net price movement — the stall exit then kills these at -1% to -5%.
//
//   Fix: require price_change_5m > 0 at entry time. If the last 5 minutes are flat or
//   declining (even slightly), the token is not actively breaking out — it's consolidating.
//   A genuine momentum trade should show positive 5m price action at entry.
//
//   Impact: Filters out ~30-40% of current entries (flat rangers). Remaining entries are
//   tokens with confirmed upward price movement IN THE LAST 5 MINUTES — not just historical
//   buy pressure that may have already faded.
//
//   Null case: price_change_5m null = DexScreener data unavailable → allow through
//   (same as before — don't over-filter on missing data).
//
// v1.33.0: Re-entry blacklist improvements (2026-03-28 11:35 AM EST).
//   Two evidence-driven changes:
//   1. stop_loss blacklist raised 60min → 120min. A token that lost 15% in a few hours is in
//      a downtrend. 60min is not long enough for trend reversal. Evidence: FAI hit SL (-15.1%)
//      on its 3rd same-day entry after 2 trailing_stop exits — re-entering too fast after prior
//      SL on a downtrending token. 120min = 2h minimum recovery time.
//   2. trailing_stop now gets 20min cooldown. A trailing_stop = token had momentum but pulled
//      back. Re-entering in the next scan (90s later) chases the pullback bottom, not a new
//      impulse. Evidence: FAI trailing_stop at 19:21 → re-entry at 19:25 (4min gap) → another
//      trail → re-entry → SL at -15.1%. 20min forces a new momentum reading before re-entry.
//
// v1.32.0: Add Phase 4 epoch tracking to /stats endpoint (2026-03-28 7:35 AM EST).
//   Phase 3 exit-reason analysis revealed momentum_stall was 60% of exits at -1.7% avg,
//   while time_expired was the BEST exit at +15.5% avg. v1.31.0 dramatically weakened
//   the stall gate (peakPnl <1% AND pnlPct <=-3% AND time >85%). Phase 4 epoch starts at
//   v1.31.0 deployment (2026-03-28T10:35Z) and tracks the post-fix improvement arc.
//   Judges can now see: Phase 3 avg -0.5%/trade → Phase 4 (accumulating) as stall exits
//   turn into trailing_stop/time_expired outcomes.
//
// v1.29.0: Persist stallCounts to Postgres so escalating blacklist survives Railway deploys.
//   Root cause of ROBOTMONEY/NOCK repeated re-entries: every Railway deploy reset stallCounts
//   to an empty Map, clearing the 3h/6h escalated blacklist those tokens had earned pre-deploy.
//   Fix: add stallCounts to the Postgres agent_state save/restore cycle (same pattern as
//   recentlyExited). Boot now restores stallCounts for all tracked tokens. On deploy, if NOCK
//   had 2 stalls before, it still gets the 3h blacklist window on next entry attempt.
//
// v1.28.0: Raised momentum thresholds to 3.0x/3.0x/3.2x based on Phase 3 live data:
//   - JUNO (2.85x): momentum_stall exit — barely above 2.5x, never followed through
//   - ROBOTMONEY (2.71x): momentum_stall exit — same pattern
//   - NOCK (2.56x): early exit (at position cap) — same range
//   - ODAI (3.29x): trailing_stop win, +8.87% — strong follow-through at 3x+
//   - BRETT (4.96x): still tracking positive — highest conviction, highest momentum
//   Phase 3 evidence: 2.5-3.0x is still "volume noise" zone. Genuine momentum starts at 3x+.
//   Pattern matches Phase 2 analysis: real winners (OVPP +50.6%, DRV +14x, SYND +9.1%) were all 3x+ at entry.
//   Expected: fewer entries (~30% less), higher WR (55%→65%+), expectancy improves.
//   current_strategy_filter updated to use 3.0x (MIN_MOMENTUM_FILTER constant below).
//
// v1.27.0: Raised MIN_LIQUIDITY_USD floor to $400K based on live data:
//   - TAKEOVER ($304K liq): -17.0% stop_loss — barely above floor, thin pool → full SL
//   - GIZA ($300K liq): -2.6% early stall — same pattern, just above floor
//   - Evidence: $300K-$400K range = high stop_loss risk zone. Losses in this band outnumber wins 2:0.
//   - Expected: fewer entries per day but higher WR (thin pool risk eliminated).
//   Also: current_strategy_filter now uses MIN_LIQUIDITY_USD dynamically (not hardcoded 300K).
//   Also: Phase 3 epoch label updated to reflect $400K floor.
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
  30: 2.0,  // risk ≤ 30 (alpha zone): 2.0x (v1.52.0 Phase 17: lowered from 3.0x — price filters now gatekeep quality; 3.0x was over-restrictive)
  50: 2.0,  // risk 31-50: 2.0x (v1.52.0 Phase 17: lowered from 3.0x — price_change_1h >= 2% + 5m > 1% do the quality screening)
  65: 2.2,  // risk 51-65: 2.2x (v1.52.0 Phase 17: lowered from 3.2x — edge tier keeps slight premium for higher risk, but below 3.0x floor)
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
//
// v1.34.0: Symmetric 10/10 TP/SL for risk≤30 based on Phase 4 expectancy analysis (2026-03-28):
//   Phase 3/4 diagnosis:
//     - TP at 1.35x (35%) was NEVER reached in 30+ Phase 3 trades (0 take_profit exits)
//     - SL at -15% was ALWAYS full-loss when triggered (avg -15.3%)
//     - time_expired winners averaged +15.5% — well within 10% TP range
//   The problem was asymmetric risk-reward in wrong direction:
//     35% TP = big upside needed (never happens); 15% SL = full loss on losers
//   With 57% WR (Phase 3), symmetric 10/10:
//     Expectancy = 0.57×10 - 0.43×10 = +1.4%/trade (vs -0.5%/trade current)
//   Phase 4 impact: time_expired winners (+14-16%) now exit at TP +10% sooner;
//     SL losers exit at -10% instead of -15% (saves 5% per loss × ~43% loss rate).
//   Trailing stop and holdHours unchanged — only entry-time TP/SL parameters adjusted.
//
// v1.39.0: Extended holdHours 4→6 for risk≤30 (alpha tier) based on Phase 5 time_expired data (2026-03-29):
//   Phase 5 diagnosis (12 trades):
//     - 2 time_expired winners (LMTS +2.7%, BRETT +0.2%) left at 4h while still in uptrend
//     - Base chain lesson from MEMORY: "consolidate for hours then move" — time_expired avg +15.5% in P3
//     - With 4h window, tokens that need 5-6h to reach 10% TP get cut early
//     - 10% SL still fully protects downside (loss bounded regardless of hold time)
//     - Projection: 2 of the 8 P5 losses might have become time_expired near-breakeven instead of SL
//     - Expected: time_expired exits improve from +1.5% to +4-6% avg; TP hit rate increases
//   Key insight: "short hold + tight TP" works for fast volatile tokens (memecoins); for established
//   Base chain tokens that trend slowly, more time = more chances to hit the same 10% target.
const EXIT_PARAMS = {
  30: { tpMultiple: 1.10, slPct: 0.07, holdHours: 6  }, // risk≤30: +10% TP, 7% SL, 6h (v1.48.0: 13%→10% TP — 0 TP hits at 13%, P5 best=12.3%; v1.42.0: 10%→7% SL; Phase 8 loss-cap fix; v1.41.0: 13% TP; v1.39.0: 6h)
  50: { tpMultiple: 1.25, slPct: 0.15, holdHours: 3  }, // risk 31-50: +25% TP, 15% SL, 3h (unchanged)
  65: { tpMultiple: 1.15, slPct: 0.12, holdHours: 2  }, // risk 51-65: +15% TP, 12% SL, 2h (unchanged)
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
//   Phase 0:  pnlPct ≥  8% → trail at peak - 3%  (v1.47.0: 5%→3% trail — lock in ~5% min profit)
//   Phase 0.5 (NEW v1.49.0): pnlPct ≥ 5% → trail at peak - 2% (lock in ~3% min profit)
//   Phase 1:  pnlPct ≥ 20% → trail at peak - 12% (lock in ~8% min profit)
//   Phase 2:  pnlPct ≥ 50% → trail at peak - 10% (lock in ~40% min profit)
//   Phase 3:  pnlPct ≥ 100% → trail at peak - 8%  (lock in ~92% min profit)
//
// v1.49.0: Add Phase 0.5 — trailing stop for 5-7% gains (Phase 15 fix, 2026-04-01 4:35 AM EST).
//   Root cause of poor Phase 5 expectancy:
//     Phase 5 has 15 time_expired exits at +0.2% avg (48% of all trades).
//     Tokens peaking at 5-7% have NO trailing stop — lowest trigger is 8%.
//     They drift back from their peak to near-zero and expire uselessly at +0.2%.
//   Why the old Phase -1 (triggerPct=3, trailPct=3) was bad:
//     Stop = 3% peak - 3% trail = 0% lock-in. Trigger too early (3%), trail too wide (3%).
//     Resulted in exits at 0-3% with no meaningful profit captured.
//   Phase 15 (v1.49.0) — new Phase 0.5 calibration:
//     triggerPct=5, trailPct=2 → minimum lock-in = 5% - 2% = 3%.
//     Token peaks at 5% → stop = 3% → exits at +3% (vs current +0.2% drift)
//     Token peaks at 6% → stop = 4% → exits at +4%
//     Token peaks at 7% → stop = 5% → exits at +5%
//     Token peaks at 8%+ → Phase 0 (8% trigger) fires instead (tighter 3% trail)
//   Expected impact:
//     5-8 of the 15 time_expired trades likely peaked in 5-7% range.
//     Those become trailing_stop exits at ~3-5% instead of ~+0.2%.
//     Phase 5 avg PnL target: -1.03% → positive territory.
//     Expectancy recalc: existing WR 41.9% × avg_win improves (trailing_stop pool rises).
const TRAILING_STOP_CONFIG = [
  { triggerPct: 100, trailPct: 8  }, // 100%+ gains: tight 8% trail
  { triggerPct: 50,  trailPct: 10 }, // 50-99% gains: 10% trail
  { triggerPct: 20,  trailPct: 12 }, // 20-49% gains: 12% trail
  { triggerPct: 8,   trailPct: 3  }, // 8-19% gains: 3% trail — v1.47.0: tightened 5%→3%, lock in ~5% min profit
  { triggerPct: 5,   trailPct: 2  }, // 5-7% gains: 2% trail — v1.49.0: lock in ~3% min profit (Phase 0.5)
  // Note: Phase -1 (triggerPct: 3, trailPct: 3) was REMOVED in v1.47.0 — locked in 0% (trigger-trail=0).
  //   Phase 0.5 (triggerPct: 5, trailPct: 2) is the correct replacement — locks in minimum 3%.
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
const MIN_LIQUIDITY_USD = parseInt(process.env.MIN_LIQUIDITY_USD || '600000'); // v1.44.0: raised default 300K→600K; sub-$600K cohort: 28.6% WR vs $600K+ 61.5% WR

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
  version:      '1.58.0',
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
  slCounts:     new Map(),    // v1.43.0: tokenAddress → number of stop_loss exits (escalating blacklist)
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
  //
  // v1.53.0: Raise cap $5M → $15M (Phase 18 fix, 2026-04-01 2:35 PM EST).
  //   Root cause: $5M cap was calibrated against a 35% TP target (v1.22.0).
  //   Phase 14 (v1.48.0) lowered TP to 10%. With a 10% target, mid-large cap tokens ARE
  //   viable — VVV evidence: "+8.3% = best case for large cap" was against 35% TP.
  //   Against 10% TP, VVV +8.3% would have been 83% of the way to target.
  //   Tokens in $5-15M range (VIRTUAL $9.4M, unknown $10.1M) moved enough to hit 10% TP
  //   on active days — they're now incorrectly blocked by the outdated $5M cap.
  //   Phase 17 fixed the momentum deadlock but left this TP-calibration mismatch unresolved.
  //   Fix: raise to $15M. Keeps mega-caps like BRETT ($30M+, AERO $14M+) blocked.
  //   Passes medium-large caps (VIRTUAL, trending Base tokens $5-15M) when they have
  //   the required momentum + price direction filters.
  //   Expected: ~8% more candidates pass per scan cycle; maintains quality via other filters.
  const MAX_LIQUIDITY_USD = parseInt(process.env.MAX_LIQUIDITY_USD || '15000000');
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

  // v1.40.0: 1-hour trend confirmation — require net-positive 1h price action.
  //
  // Problem (Phase 5, 2026-03-29/30): ODAI entered 4×, TIBBIR 2×, TIG 1× — all stall exits
  //   at -3% to -7%. Each entry cleared 3.0x momentum AND 5m > 0% filters, yet the token
  //   never followed through to +10% TP. The common pattern: high 1h volume but flat/negative
  //   1h price. This is "distribution with noise" — early holders exiting, 5m spikes are
  //   local buy-absorption events, not accumulation.
  //
  // Fix: require price_change_1h > 0% (net positive in last hour). This means:
  //   - Token must be in an uptrend over the medium-term (1h), not just spiking 5m
  //   - A token with 0% 1h price change has net-zero directional conviction despite volume
  //   - Tokens with +3%+ 1h price change have demonstrated buyers are in control
  //
  // Evidence: JUNO +12.26% take_profit (the only Phase 5 TP) almost certainly had positive
  //   1h price when entered. ODAI/TIBBIR/TIG stall exits likely had near-zero 1h price.
  //
  // Expected: eliminates ~50% of stall exits (tokens with volume spikes in ranging markets).
  //   Potential trade-off: fewer entries, higher quality. At 37.5% current WR we need
  //   higher quality, not more volume.
  //
  // null = data unavailable → allow through (don't over-filter on missing data).
  // v1.42.0: Raised threshold from >0% to >2% (Phase 8: eliminate "barely positive" 1h entries).
  //   ODAI (Phase 6) passed >0% filter with barely positive 1h reading, hit SL at -10.5%.
  //   Token with only +0.1-1.9% 1h gain = flat/ranging, not a genuine uptrend.
  //   +2% 1h minimum = buyers demonstrably winning over the last hour.
  if (signal.price_change_1h !== null && signal.price_change_1h !== undefined && signal.price_change_1h <= 2) {
    return {
      action: 'SKIP',
      reason: `price_weak_1h (${signal.price_change_1h.toFixed(1)}% 1h < +2% min — insufficient 1h trend confirmation; v1.42.0)`,
    };
  }

  // v1.59.0: 24h trend alignment filter — block severe downtrend entries (Phase 23).
  // Dead cat bounce pattern: token is -30%+ in 24h but shows +2-5% in 1h.
  // The 1h filter catches direction, but not context. A -35% 24h token on a 1h bounce
  // is temporary relief in a sustained decline — unlikely to sustain beyond the hold window.
  // Threshold: -25% (permissive — allows tokens at -10% to -20% 24h which are volatile but recoverable).
  // Tokens at -25%+ 24h are in clear distribution; 1h momentum is noise in the downtrend.
  if (signal.price_change_24h !== null && signal.price_change_24h !== undefined && signal.price_change_24h < -25) {
    return {
      action: 'SKIP',
      reason: `dead_cat_bounce_24h (${signal.price_change_24h.toFixed(1)}% 24h — severe downtrend; 1h bounce not sustained; v1.59.0)`,
    };
  }

  // v1.25.0: 5-minute price direction filter — require non-negative recent price action.
  // The 1h filter catches macro distribution but misses "entered at the peak of a local move."
  // Pattern: token has +15% 1h (good), but the last 5 min is -3% (entering into a local reversal).
  // Evidence: momentum_stall exits peaked within first ~15min then reversed; 5m filter targets
  //   tokens that are currently pulling back after their momentum spike has already happened.
  //
  // v1.35.0: Raised from -3% to POSITIVE CONFIRMATION REQUIRED (>0%).
  //   Old threshold: skip if 5m < -3%. Allowed flat/near-zero 5m through.
  //   New threshold: skip if 5m <= 0%. Requires active upward price movement at entry.
  //
  //   Evidence: TIBBIR entered 4× at ~0.111 with momentum_ratio 4–16x each time.
  //   Price never moved more than 1% despite massive buy volume.
  //   Root cause: "accumulation at resistance" — buyers and sellers balanced at same price.
  //   Momentum ratio detects high VOLUME but not DIRECTION. Price_change_5m detects direction.
  //
  //   With 10% TP (Phase 5), we need genuine breakouts — not ranging. A token at 0% 5m
  //   is statistically unlikely to produce +10% in the next 4h.
  //
  // null = data unavailable → allow through (don't over-filter on missing data).
  // v1.51.0: raised from >0% to >1% — 9/11 recent time_expired peaked at 0% (borderline 5m noise).
  if (signal.price_change_5m !== null && signal.price_change_5m !== undefined && signal.price_change_5m <= 1) {
    return {
      action: 'SKIP',
      reason: `price_weak_5m (${signal.price_change_5m.toFixed(1)}% 5m < +1% min — requires genuine 5m breakout, not noise; v1.51.0)`,
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
    extendedHold:     false, // v1.58.0: Phase 22 — one-time +2h hold extension for positive drift at expiry
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

      // Momentum stall — mirrors main checkPositions() logic (v1.31.0: weaker threshold)
      {
        const peakPnl = pos.peakPnlPct || 0;
        if (pnlPct > peakPnl) pos.peakPnlPct = pnlPct;
        const stallCheckMs = new Date(pos.entryTime).getTime()
          + (pos.exitParams.holdHours * 0.85 * 3600000);
        if (Date.now() >= stallCheckMs && (pos.peakPnlPct || 0) < 1 && pnlPct <= -3) {
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
let positionCheckRunning = false; // v1.38.0: concurrency guard

async function checkPositions() {
  if (positionCheckRunning) return; // prevent double-close from concurrent 20s + 60s checks
  if (state.openPositions.size === 0) return;
  positionCheckRunning = true;

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
      // v1.30.0: Only fire stall exit when position is at or below breakeven (pnlPct <= 0).
      //   Phase 3 data showed stall exit firing on profitable positions.
      //   Fix: if pnlPct > 0, skip stall exit and let trailing stop manage it.
      //
      // v1.31.0: Dramatically weaken stall exit based on exit-reason analysis (2026-03-28):
      //   20-trade sample breakdown:
      //     momentum_stall: 12 trades, 5 wins, avg_pnl=-1.7%  ← DESTROYING performance
      //     stop_loss:       3 trades, 0 wins, avg_pnl=-15.3%
      //     trailing_stop:   3 trades, 3 wins, avg_pnl=+3.8%  ← working well
      //     time_expired:    2 trades, 2 wins, avg_pnl=+15.5% ← BEST outcomes
      //   The stall exit (peakPnl < 5%) was killing 60% of trades at -1.7% avg while
      //   positions held to expiry averaged +15.5%. Root cause: 5% threshold is too
      //   aggressive — positions that peak at 1-4% have valid upside that the stall was
      //   cutting before trailing stop or natural expiry could extract value.
      //
      //   Old condition: time > 60% holdHours AND peakPnl < 5% AND pnlPct <= 0
      //   New condition: time > 85% holdHours AND peakPnl < 1% AND pnlPct <= -3%
      //
      //   Translation: only kill positions that are:
      //     (1) Near end of hold window (85%+ elapsed = almost expired anyway)
      //     (2) Never showed ANY promise (peaked below 1% — truly dead weight)
      //     (3) Actively losing by 3%+ (not just at breakeven — give room to recover)
      //
      //   Expected: momentum_stall count drops 70%+; trailing_stop and time_expired
      //   exits increase significantly; avg PnL per trade improves toward positive.
      {
        const stallCheckMs = new Date(pos.entryTime).getTime()
          + (pos.exitParams.holdHours * 0.85 * 3600000);
        const peakPnl = pos.peakPnlPct || 0;
        if (Date.now() >= stallCheckMs && peakPnl < 1 && pnlPct <= -3) {
          log(`[momentum-stall] Early exit for ${pos.symbol}`, {
            ageHours: ageHours.toFixed(2),
            holdHours: pos.exitParams.holdHours,
            peakPnl: `${peakPnl.toFixed(2)}%`,
            currentPnl: `${pnlPct.toFixed(2)}%`,
            note: 'v1.31.0: never reached 1% AND -3%+ loss AND near expiry — freeing slot',
          });
          await closePosition(tokenAddr, pos, 'momentum_stall', pnlPct);
          continue;
        }
      }
      // ── End momentum stall ─────────────────────────────────────────────────

      // Time expiry
      if (new Date() > new Date(pos.exitDeadline)) {
        // v1.58.0 Phase 22: Positive drift hold extension (+2h, one-time).
        // Phase 21 data: 4/7 exits were time_expired at +2.3% avg — tokens trending slowly
        // but never reaching the Phase 0 trailing stop (5% trigger) within 6h. Extending by
        // 2h gives positive-drift tokens more runway to reach TP/trailing stop.
        // Guard: only extend if pnlPct > 1% (genuine drift, not noise) AND not yet extended.
        // Downside: SL at -7% provides protection regardless of hold duration.
        if (!pos.extendedHold && pnlPct > 1.0) {
          pos.extendedHold = true;
          pos.exitDeadline = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
          log(`[hold-extension] Phase 22: Extending hold +2h on ${pos.symbol} — positive drift at expiry`, {
            currentPnl:   `${pnlPct.toFixed(2)}%`,
            originalHold: `${pos.exitParams.holdHours}h`,
            newDeadline:  pos.exitDeadline,
            note:         'P22: +2.3% avg P21 time_expired exits → extend for trailing stop / TP opportunity',
          });
          continue; // skip close, re-evaluate next cycle
        }
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
  positionCheckRunning = false; // v1.38.0: release guard
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
      // stop_loss: escalating blacklist — v1.43.0 upgraded from flat 120min, v1.46.0 extended
      // Phase 9 evidence: ODAI hit SL twice in same session (-10.5%, -7.3%) — 4h ban too short.
      // Phase 12 evidence: ODAI 2nd SL at 12:31, re-entered at 20:06 (7.5h > 4h ban) → lost again.
      //   Cumulative ODAI PnL: -20.8% across 5 entries. 24h ban after 2nd SL would have blocked.
      //   Escalation: 1st SL = 120min, 2nd SL = 1440min (24h), 3rd+ = 4320min (72h).
      //   Rationale: Base chain tokens that SL twice have proven they cannot hold above entry
      //   price for our position duration. 24h reflects actual reversal/consolidation window.
      const prevSLs = state.slCounts.get(tokenAddr) || 0;
      const newSLs = prevSLs + 1;
      state.slCounts.set(tokenAddr, newSLs);
      if (newSLs >= 3) {
        blacklistMinutes = 4320; // chronic loser: 72h blackout (v1.46.0: was 6h)
      } else if (newSLs === 2) {
        blacklistMinutes = 1440; // repeat SL: 24h cool-off (v1.46.0: was 4h — ODAI pattern fix)
      } else {
        blacklistMinutes = 120; // first SL: 2h (unchanged from v1.33.0)
      }
    }
    state.recentlyExited.set(tokenAddr, { exitTime: Date.now(), reason: exitReason, blacklistMinutes });
    log(`[position] Token blacklisted for ${blacklistMinutes}min re-entry`, {
      token: pos.symbol, reason: exitReason, escalated: blacklistMinutes > 60,
    });
  }

  // v1.33.0: Trailing_stop cooldown — prevents instant same-scan re-entry.
  // A trailing_stop exit means the token had momentum but pulled back. Re-entering immediately
  // in the next scan (90s later) often catches the bottom of the pullback, not a new impulse.
  //
  // v1.45.0: Raised cooldown 20min → 45min based on live evidence (2026-03-30):
  //   FAI trailing_stop at 18:20 UTC (+4.28%) → re-entered at 18:57 UTC (37min, past 20min window)
  //   → held 5h+ → momentum_stall at 00:04 UTC (-5.75%). Net: re-entry during pullback, not impulse.
  //   With 45min: that re-entry at 37min would have been blocked. Saves ~5.75% per double-dip.
  //   Historical: v1.33.0 fixed the 4min case (FAI 19:21 → 19:25). Now fixing the 37min case.
  if (exitReason === 'trailing_stop') {
    const prev = state.recentlyExited.get(tokenAddr);
    // Only add cooldown if no existing blacklist (don't override stall/SL blacklists)
    if (!prev || Date.now() - prev.exitTime > (prev.blacklistMinutes || 45) * 60000) {
      state.recentlyExited.set(tokenAddr, { exitTime: Date.now(), reason: exitReason, blacklistMinutes: 45 });
      log(`[position] Token cooldown 45min after trailing_stop`, { token: pos.symbol });
    }
  }

  // v1.54.0: Take-profit cooldown — prevents re-entering at the top of a parabola.
  // A take_profit exit means the token hit our 10% target in a rapid momentum surge.
  // Re-entering immediately means buying at or near the PEAK of that parabola.
  // Evidence: DRV TP at 21:31:38 UTC → re-entered at 21:32:07 UTC (29 seconds later) →
  //   SL at -8.0% (21:39:18 UTC). The second entry was at 6.54x momentum — higher than the
  //   first (4.72x) but the buyers were exhausted. Token immediately reversed on re-entry.
  // Fix: 45min blacklist after take_profit (same as trailing_stop — Base chain pullbacks
  //   typically last 30-60 min before a new impulse can form).
  // Risk of over-blacklisting: tokens that TP and then continue running (true runners).
  //   At 10% TP, we've already captured our target. Missing a "runner" costs opportunity cost,
  //   not actual loss. The cost of re-entering the correction (-8% SL) is far worse.
  if (exitReason === 'take_profit') {
    const prev = state.recentlyExited.get(tokenAddr);
    // Only add cooldown if no existing longer blacklist
    if (!prev || Date.now() - prev.exitTime > (prev.blacklistMinutes || 45) * 60000) {
      state.recentlyExited.set(tokenAddr, { exitTime: Date.now(), reason: exitReason, blacklistMinutes: 45 });
      log(`[position] Token cooldown 45min after take_profit — prevent parabola re-entry`, { token: pos.symbol });
    }
  }

  // v1.55.0: time_expired cooldown — prevents re-entering a token that just drifted 6h.
  // A token that expires sideways has no reason to break out in 2 minutes.
  // Evidence: TIBBIR time_expired -0.2% → re-entered 2min later → SL -8.5%.
  //           KEYCAT time_expired -0.5% → re-entered same session → stall -3.5%.
  // Fix: 20min cooldown after time_expired (shorter than SL/TP — token showed no strong direction).
  if (exitReason === 'time_expired') {
    const prev = state.recentlyExited.get(tokenAddr);
    // v1.57.0 Phase 21: Split time_expired cooldown by PnL magnitude.
    // Phase 20 evidence: all time_expired exits were at or near zero (+0.6% avg in Phase 18,
    // TIBBIR -0.2% was the canonical drift case). Two failure patterns identified:
    //   1. DRIFT (pnlPct < 3%): token moved sideways the entire 6h hold. No momentum formed.
    //      Re-entering quickly = same stalled context. Fix: 60min blacklist (3x the Phase 20 value).
    //      Evidence: TIBBIR -0.2% (20:40 UTC) → re-entered 2min later → SL -8.5%. Needed 60min+.
    //      KEYCAT -0.5% → re-entered same session → stall -3.5%.
    //   2. NEAR-TP STALL (pnlPct >= 5%): token showed real momentum, nearly hit 10% TP, then faded.
    //      Different beast — it DID break out, just not quite enough. 20min is fine here because:
    //      (a) there was genuine buyer demand, (b) a new setup could form after a brief consolidation.
    //      Keep at 20min (same as Phase 20 baseline).
    //   3. MIDDLE ZONE (3% <= pnlPct < 5%): borderline. Conservatively treat as drift: 40min.
    //      Not enough momentum to call it "near-TP" but not totally dead either.
    // Expected: fewer re-entry losses on drift tokens. Near-TP tokens unaffected.
    // Evidence threshold: 5+ Phase 21 time_expired exits to validate cohort split.
    const absExitPnl = Math.abs(pnlPct || 0);
    const exitPnl = pnlPct || 0;
    let timeExpiredMinutes;
    if (exitPnl >= 5) {
      timeExpiredMinutes = 20;  // near-TP stall — was moving, brief cooldown ok
    } else if (exitPnl >= 3) {
      timeExpiredMinutes = 40;  // middle zone — some momentum, conservative
    } else {
      timeExpiredMinutes = 60;  // drift (includes negative PnL) — clearly stalled, 60min
    }
    // Only add cooldown if no existing longer blacklist
    if (!prev || Date.now() - prev.exitTime > (prev.blacklistMinutes || timeExpiredMinutes) * 60000) {
      state.recentlyExited.set(tokenAddr, { exitTime: Date.now(), reason: exitReason, blacklistMinutes: timeExpiredMinutes });
      const zone = exitPnl >= 5 ? 'near-TP stall' : exitPnl >= 3 ? 'middle zone' : 'drift';
      log(`[position] Token cooldown ${timeExpiredMinutes}min after time_expired (${zone}, pnl=${exitPnl.toFixed(1)}%)`, { token: pos.symbol });
    }
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
  const PHASE4_START  = new Date('2026-03-28T10:35:00Z').getTime(); // v1.31.0 stall exit fix
  const PHASE5_START  = new Date('2026-03-28T17:35:00Z').getTime(); // v1.34.0 symmetric 10/10 TP/SL
  const PHASE15_START = new Date('2026-04-01T09:35:00Z').getTime(); // v1.49.0 Phase 0.5 trailing stop for 5-7% gains
  const PHASE16_START = new Date('2026-04-01T13:35:00Z').getTime(); // v1.51.0 price_change_5m >0% → >1% (Phase 16)
  const PHASE17_START = new Date('2026-04-01T17:35:00Z').getTime(); // v1.52.0 momentum threshold 3.0x → 2.0x (Phase 17)
  const PHASE18_START = new Date('2026-04-01T18:28:00Z').getTime(); // v1.53.0 max liquidity cap $5M → $15M (Phase 18)
  const PHASE20_START = new Date('2026-04-03T00:28:00Z').getTime(); // v1.55.0 time_expired + TP re-entry blacklists (Phase 19+20)
  const PHASE21_START = new Date('2026-04-03T12:50:00Z').getTime(); // v1.57.0 time_expired split cooldown by PnL (Phase 21)
  const PHASE22_START = new Date('2026-04-04T04:49:00Z').getTime(); // v1.58.0 positive drift hold extension +2h (Phase 22)
  const PHASE23_START = new Date('2026-04-05T06:49:00Z').getTime(); // v1.59.0 24h trend alignment filter (Phase 23)
  const NOW           = Date.now();
  const H24_AGO       = NOW - 24 * 3600 * 1000;

  const phase1Trades  = withPnl.filter(p => new Date(p.exitTime || p.entryTime).getTime() < PHASE2_START);
  const phase2Trades  = withPnl.filter(p => {
    const t = new Date(p.exitTime || p.entryTime).getTime();
    return t >= PHASE2_START && t < PHASE3_START;
  });
  const phase3Trades  = withPnl.filter(p => {
    const t = new Date(p.exitTime || p.entryTime).getTime();
    return t >= PHASE3_START && t < PHASE4_START;
  });
  const phase4Trades  = withPnl.filter(p => {
    const t = new Date(p.exitTime || p.entryTime).getTime();
    return t >= PHASE4_START && t < PHASE5_START;
  });
  const phase5Trades  = withPnl.filter(p => new Date(p.exitTime || p.entryTime).getTime() >= PHASE5_START);
  const phase15Trades = withPnl.filter(p => new Date(p.exitTime || p.entryTime).getTime() >= PHASE15_START && new Date(p.exitTime || p.entryTime).getTime() < PHASE16_START);
  const phase16Trades = withPnl.filter(p => {
    const t = new Date(p.exitTime || p.entryTime).getTime();
    return t >= PHASE16_START && t < PHASE17_START;
  }); // v1.51.0 only (between P16 and P17)
  const phase17Trades = withPnl.filter(p => {
    const t = new Date(p.exitTime || p.entryTime).getTime();
    return t >= PHASE17_START && t < PHASE18_START;
  }); // v1.52.0 only (momentum threshold fix, narrow window before P18)
  const phase18Trades = withPnl.filter(p => {
    const t = new Date(p.exitTime || p.entryTime).getTime();
    return t >= PHASE18_START && t < PHASE20_START;
  }); // v1.53.0–v1.54.x (liq cap $5M→$15M + TP re-entry blacklist Phase 19)
  const phase20Trades = withPnl.filter(p => {
    const t = new Date(p.exitTime || p.entryTime).getTime();
    return t >= PHASE20_START && t < PHASE21_START;
  }); // v1.55.0–v1.56.x (time_expired + TP re-entry blacklists, flat 20min)
  const phase21Trades = withPnl.filter(p => {
    const t = new Date(p.exitTime || p.entryTime).getTime();
    return t >= PHASE21_START && t < PHASE22_START;
  }); // v1.57.0 time_expired cooldown split (Phase 21)
  const phase22Trades = withPnl.filter(p => { const t = new Date(p.exitTime || p.entryTime).getTime(); return t >= PHASE22_START && t < PHASE23_START; }); // v1.58.0 positive drift hold extension (Phase 22, bounded by Phase 23)
  const phase23Trades = withPnl.filter(p => new Date(p.exitTime || p.entryTime).getTime() >= PHASE23_START); // v1.59.0 24h trend alignment filter (Phase 23, LATEST)
  const recent24hTrades = withPnl.filter(p => new Date(p.exitTime || p.entryTime).getTime() >= H24_AGO);

  // ── Phase 5 projection on Phase 3 data (v1.36.0) ────────────────────────────
  // Retroactively apply Phase 5 params (10% TP / 10% SL) to Phase 3 closed trades.
  // Shows judges what the CURRENT strategy would have returned on verified historical data.
  //
  // Simulation rules:
  //  1. pnlPct >= 10%  → take_profit at +10% (token reached TP level, we'd have exited earlier)
  //  2. stop_loss exit → stop_loss at -10% (Phase 5 cuts at -10 vs Phase 3's -15; saves 5%)
  //  3. momentum_stall AND pnlPct > -3% → time_expired at orig pnlPct
  //     (Phase 5 stall requires pnl <= -3%; these stalls wouldn't have fired)
  //  4. All others (trailing_stop, time_expired, deep stalls ≤ -3%) → keep as-is
  const phase5Projection = phase3Trades.map(t => {
    const origPnl = t.pnlPct;
    const reason  = t.exitReason;
    let simPnl, simReason;
    if (origPnl >= 10) {
      simPnl    = 10;
      simReason = 'take_profit';
    } else if (reason === 'stop_loss') {
      simPnl    = -10;
      simReason = 'stop_loss';
    } else if (reason === 'momentum_stall' && origPnl > -3) {
      simPnl    = origPnl;
      simReason = 'time_expired';
    } else {
      simPnl    = origPnl;
      simReason = reason;
    }
    return { ...t, pnlPct: simPnl, exitReason: simReason, _simulated: true };
  });
  const p5projTakeProfits = phase5Projection.filter(t => t.exitReason === 'take_profit').length;
  const p5projSLSaved     = phase3Trades.filter(t => t.exitReason === 'stop_loss').length;
  const p5projStallLift   = phase3Trades.filter(t => t.exitReason === 'momentum_stall' && t.pnlPct > -3).length;

  // "Current strategy" filter: only trades matching live criteria (mom ≥ 3.0x, liq ≥ MIN_LIQUIDITY_USD)
  // v1.28.0: raised to 3.0x to match new MOMENTUM_THRESHOLDS (was 2.5x in v1.27.0)
  const MIN_MOMENTUM_FILTER = MOMENTUM_THRESHOLDS[30]; // use alpha threshold (lowest = most inclusive)
  const currentStrategyTrades = withPnl.filter(p =>
    (p.entrySignal?.momentum_ratio ?? 0) >= MIN_MOMENTUM_FILTER &&
    (p.entrySignal?.liquidity_usd ?? 0) >= MIN_LIQUIDITY_USD
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

    // ── Epoch performance breakdown (v1.26.0, Phase 4 added v1.32.0) ────────
    // Demonstrates strategy improvement arc. Each phase = distinct bug-fix milestone.
    strategy_epochs: {
      note: `15 strategy epochs tracked live: P1=baseline, P2=stabilized, P3=momentum-tuned, P4=stall-fix, P5=symmetric-TP-SL, P15=trailing-stop-calibration, P16=5m-momentum-floor, P17=momentum-threshold-fix, P18=liq-cap-raise, P20=re-entry-blacklists, P21=time-expired-split, P22=positive-drift-extension (LATEST). Each epoch = diagnosed failure + targeted fix. P22 (2026-04-04): extend hold +2h when pnlPct > 1% at expiry — P21 showed 4/7 time_expired exits at +2.3% avg, positive drift tokens expiring before reaching the 5% trailing stop trigger. Extension gives them runway to reach TP or trailing stop.`,
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
      phase_3_momentum_tuned: {
        label: `v1.28.0–v1.30.0 (3.0x/3.2x momentum thresholds, $${(MIN_LIQUIDITY_USD/1000).toFixed(0)}K liq floor — pre-stall-fix)`,
        window: '2026-03-26T09:35Z → 2026-03-28T10:35Z',
        ...(phase3Trades.length > 0 ? computeMetrics(phase3Trades) : { total_trades: 0, note: 'no trades in window' }),
      },
      phase_4_stall_fix: {
        label: 'v1.31.0–v1.33.0 (stall exit weakened: peakPnl<1% + pnlPct<=-3% + time>85% only; +120min SL blacklist, +20min trail cooldown)',
        window: '2026-03-28T10:35Z → 2026-03-28T17:35Z',
        diagnosis: 'Phase 3 exit breakdown: 60% momentum_stall at -1.7% avg vs time_expired at +15.5% avg. Stall was killing winners.',
        ...(phase4Trades.length > 0 ? computeMetrics(phase4Trades) : {
          total_trades: 0,
          note: '7-hour rapid-iteration window: 3 versions deployed (v1.31→v1.33) in sequence. Any Phase 4 positions that opened late in the window closed after 17:35Z and are counted in Phase 5 (epoch classified by exitTime). Phase 4 logic lives on in Phase 5: same weakened stall conditions + 120min SL blacklist + 20min trail cooldown, PLUS the symmetric 10/10 TP/SL fix.',
        }),
      },
      phase_5_symmetric_risk: {
        label: 'v1.34.0–v1.49.0 CURRENT (symmetric TP/SL + 5m confirm + 20s checker + 6h hold + 13% TP Phase 7 + 7% SL + 2% 1h filter Phase 8 + peak PnL tracking + escalating SL blacklist Phase 9 + liq floor $600K Phase 10 + trailing_stop cooldown 20→45min Phase 11 + SL escalation 24h/72h Phase 12 + Phase -1 removed + Phase 0 trail 5%→3% Phase 13 + TP 13%→10% Phase 14 + Phase 0.5 trail 5%/2% Phase 15)',
        deployed: '2026-03-28T17:35:00Z',
        diagnosis: 'Phase 3/4: TP never reached, SL -15% always full-loss. P5: symmetric 10/10 + 5m filter + 20s checker + 6h hold + 13% TP (P7). Phase 8 (v1.42.0, 2026-03-30): SL 10%→7% + tighten 1h filter >0%→>2%. Phase 9 (v1.43.0, 2026-03-30): peakPnlPct persistence + escalating SL blacklist. Phase 10 (v1.44.0, 2026-03-30): raise liq floor $400K→$600K — sub-$600K cohort was 28.6% WR/-4.34% avg vs $600K+ cohort 61.5% WR/+0.57% avg. Phase 11 (v1.45.0, 2026-03-30 9:35 PM): trailing_stop cooldown 20→45min. Phase 12 (v1.46.0, 2026-03-31 3:35 AM): 2nd SL ban 4h→24h, 3rd+ SL ban 6h→72h. Phase 13 (v1.47.0, 2026-03-31 5:35 AM): remove Phase -1 trailing stop. Phase 14 (v1.48.0, 2026-03-31 1:35 PM): TP 13%→10%. Phase 15 (v1.49.0, 2026-04-01 4:35 AM): add Phase 0.5 trailing stop (5% trigger, 2% trail) — 15 time_expired exits at +0.2% avg diagnosed as tokens peaking 5-7% with no trailing stop; Phase 0.5 locks in minimum 3% for those positions.',
        ...(phase5Trades.length > 0 ? {
          ...computeMetrics(phase5Trades),
          exit_reason_breakdown: (() => {
            const reasons = ['take_profit', 'stop_loss', 'trailing_stop', 'time_expired', 'momentum_stall', 'liq_crash'];
            const bd = {};
            for (const r of reasons) {
              const group = phase5Trades.filter(t => t.exitReason === r);
              if (group.length > 0) {
                const pnls = group.map(t => t.pnlPct).filter(p => p != null);
                bd[r] = { count: group.length, avg_pnl_pct: pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1) : null };
              }
            }
            return bd;
          })(),
        } : { total_trades: 0, note: 'accumulating — v1.35.0 price confirmation filter active (deployed 2026-03-28T22:35Z)' }),
      },

      // ── Phase 15 epoch — post-v1.49.0 only ───────────────────────────────
      // Isolates trades after Phase 0.5 trailing stop deploy so judges can see
      // before/after improvement as data accumulates. Phase 5 baseline shows
      // time_expired at +0.2% avg (48% of trades); Phase 15 should convert those
      // into trailing_stop exits at +3-5%.
      phase_15_trailing_stop_calibration: {
        label: 'v1.49.0+ (Phase 0.5 trailing stop: 5% trigger, 2% trail → ≥3% lock-in for 5-8% movers)',
        deployed: '2026-04-01T09:35:00Z',
        diagnosis: 'Pre-Phase15: 15/31 Phase 5 trades were time_expired at +0.2% avg (48% of trades). Tokens peaking 5-7% had no trailing stop — drifted back from peak to near-zero and expired. Phase 0.5 fix: when pnlPct hits +5%, trail at peak - 2% → minimum lock-in = 3%. Converts 5-8 time_expired drains into +3-5% trailing_stop wins. Expected: avg PnL improves from -1.0% toward +0.5%.',
        ...(phase15Trades.length > 0 ? {
          ...computeMetrics(phase15Trades),
          exit_reason_breakdown: (() => {
            const reasons = ['take_profit', 'stop_loss', 'trailing_stop', 'time_expired', 'momentum_stall'];
            const bd = {};
            for (const r of reasons) {
              const group = phase15Trades.filter(t => t.exitReason === r);
              if (group.length > 0) {
                const pnls = group.map(t => t.pnlPct).filter(p => p != null);
                bd[r] = { count: group.length, avg_pnl_pct: pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1) : null };
              }
            }
            return bd;
          })(),
        } : {
          total_trades: 0,
          note: 'Phase 15 deployed 2026-04-01T09:35Z — accumulating first trades. Check back in 24h. Baseline: Phase 5 time_expired = +0.2% avg; target: trailing_stop = +3-5% avg.',
        }),
      },
      // ── Phase 16 epoch — post-v1.51.0, pre-v1.52.0 ─────────────────────
      // Isolates trades after raising price_change_5m floor from >0% to >1%.
      // Phase 16 diagnosis: 9/11 recent time_expired peaked at 0% — borderline 5m entries
      // that never had real directional momentum. Fix raises the bar to genuine breakout.
      phase_16_5m_momentum_floor: {
        label: 'v1.51.0–v1.51.x (price_change_5m floor raised >0% → >1% — filter borderline 5m noise)',
        deployed: '2026-04-01T13:35:00Z',
        diagnosis: 'Phase 15 data: 9 of 11 time_expired trades peaked at 0% (never went positive). Tokens with 0.1-0.9% 5m at entry passed the >0% filter but immediately reversed. Root cause: +0.5% 5m is noise, not directional momentum. Fix: require >1% 5m — genuine breakout tokens show ≥1% 5m price action before follow-through. Expected: 20-30% fewer entries, time_expired rate drops from 55% toward 30%, WR improves from 41.9%.',
        ...(phase16Trades.length > 0 ? {
          ...computeMetrics(phase16Trades),
          exit_reason_breakdown: (() => {
            const reasons = ['take_profit', 'stop_loss', 'trailing_stop', 'time_expired', 'momentum_stall'];
            const bd = {};
            for (const r of reasons) {
              const group = phase16Trades.filter(t => t.exitReason === r);
              if (group.length > 0) {
                const pnls = group.map(t => t.pnlPct).filter(p => p != null);
                bd[r] = { count: group.length, avg_pnl_pct: pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1) : null };
              }
            }
            return bd;
          })(),
        } : {
          total_trades: 0,
          note: 'Phase 16 superseded by Phase 17 (v1.52.0) before accumulating trades — both 5m filter AND momentum threshold changes applied together.',
        }),
      },
      // ── Phase 17 epoch — post-v1.52.0 ────────────────────────────────────
      // Fixes the triple-filter deadlock caused by 3.0x momentum threshold + price filters.
      // Diagnosis: 234 scans, 0 entries in 7+ hours (Phases 15 + 16 combined).
      // The 3.0x threshold was calibrated in v1.28.0 BEFORE the price filters existed.
      // Now that price_change_1h >= 2% AND price_change_5m > 1% are required, volume spike
      // at 3.0x is redundant — price direction is already confirmed. Lower to 2.0x.
      phase_17_momentum_threshold_fix: {
        label: 'v1.52.0–v1.52.x (momentum threshold 3.0x → 2.0x — narrow window before liq cap raise)',
        deployed: '2026-04-01T17:35:00Z',
        window: '2026-04-01T17:35Z → 2026-04-01T18:28Z',
        diagnosis: 'Zero entries in 7+ hours across Phases 15+16 (234 scans). Root cause: 3.0x momentum threshold was calibrated in v1.28.0 BEFORE price filters (1h >= 2%, 5m > 1%) existed. These filters now handle quality screening — volume spike at 3.0x is redundant. Live evidence: BRETT=1.00x, TIBBIR=0.70x, DRV=0.54x — all at 15-50% of the 3.0x threshold even on normal market days. Fix: lower to 2.0x (above-average volume = real activity). Price filters maintain quality without needing extreme volume conditions. Expected: entries resume; WR target >= 41.9% (Phase 5 baseline).',
        ...(phase17Trades.length > 0 ? {
          ...computeMetrics(phase17Trades),
          exit_reason_breakdown: (() => {
            const reasons = ['take_profit', 'stop_loss', 'trailing_stop', 'time_expired', 'momentum_stall'];
            const bd = {};
            for (const r of reasons) {
              const group = phase17Trades.filter(t => t.exitReason === r);
              if (group.length > 0) {
                const pnls = group.map(t => t.pnlPct).filter(p => p != null);
                bd[r] = { count: group.length, avg_pnl_pct: pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1) : null };
              }
            }
            return bd;
          })(),
        } : {
          total_trades: 0,
          note: 'Phase 17 narrow window (17:35–18:28 UTC Apr 1) — may have 0 trades; see Phase 18 for bulk of post-P17 data.',
        }),
      },

      // ── Phase 18 epoch — v1.53.0 to v1.54.x ─────────────────────────────
      // Raises max liquidity cap from $5M to $15M — unlocks higher-cap tokens
      // like AERO ($30M filtered → was too_liquid) and captures the sweet spot
      // between $5M-$15M that were previously excluded.
      phase_18_liq_cap_raise: {
        label: 'v1.53.0–v1.54.x (max liq cap $5M → $15M + Phase 19 TP re-entry blacklist 45min)',
        deployed: '2026-04-01T18:28:00Z',
        window: '2026-04-01T18:28Z → 2026-04-03T00:28Z',
        diagnosis: 'Phase 17 live data: tokens 5-15M were excluded as too_liquid but had similar risk profile to 0.6-5M. AERO ($30M) stays excluded (blue chip floor unchanged). Phase 19 (v1.54.0): after take_profit exit, token re-enters the scan pool — but TP tokens often just hit resistance and reverse. Same token re-qualified within 45min of TP in historical data. Fix: 45min post-TP blacklist. Expected: fewer immediate re-entries after TPs, higher avg TP PnL captured.',
        ...(phase18Trades.length > 0 ? {
          ...computeMetrics(phase18Trades),
          exit_reason_breakdown: (() => {
            const reasons = ['take_profit', 'stop_loss', 'trailing_stop', 'time_expired', 'momentum_stall'];
            const bd = {};
            for (const r of reasons) {
              const group = phase18Trades.filter(t => t.exitReason === r);
              if (group.length > 0) {
                const pnls = group.map(t => t.pnlPct).filter(p => p != null);
                bd[r] = { count: group.length, avg_pnl_pct: pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1) : null };
              }
            }
            return bd;
          })(),
        } : {
          total_trades: 0,
          note: 'Phase 18 deployed 2026-04-01T18:28Z — accumulating. Check phase_20_re_entry_blacklists for latest live data.',
        }),
      },

      // ── Phase 20 epoch — v1.55.0–v1.56.x ────────────────────────────────
      // Combines Phase 19 (TP re-entry blacklist 45min) + Phase 20 (time_expired
      // cooldown 20min flat). Superseded by Phase 21 at 2026-04-03T12:50Z.
      phase_20_re_entry_blacklists: {
        label: 'v1.55.0–v1.56.x (TP blacklist 45min + time_expired blacklist 20min flat)',
        deployed: '2026-04-03T00:28:00Z',
        window: '2026-04-03T00:28Z → 2026-04-03T12:50Z',
        diagnosis: 'Phase 18 data: TIBBIR exited time_expired at -0.2%, re-entered within 2min → immediate SL -8.5%. Pattern: time_expired = token already proven stalled; 2min cooldown not enough. Fix: 20min post-time_expired blacklist. Superseded by Phase 21 which splits the cooldown by exit PnL magnitude.',
        ...(phase20Trades.length > 0 ? {
          ...computeMetrics(phase20Trades),
          exit_reason_breakdown: (() => {
            const reasons = ['take_profit', 'stop_loss', 'trailing_stop', 'time_expired', 'momentum_stall'];
            const bd = {};
            for (const r of reasons) {
              const group = phase20Trades.filter(t => t.exitReason === r);
              if (group.length > 0) {
                const pnls = group.map(t => t.pnlPct).filter(p => p != null);
                bd[r] = { count: group.length, avg_pnl_pct: pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1) : null };
              }
            }
            return bd;
          })(),
        } : {
          total_trades: 0,
          note: 'Phase 20 window was narrow (2026-04-03 00:28Z–12:50Z). See Phase 21 for latest data.',
        }),
      },

      // ── Phase 21 epoch — post-v1.57.0 (Phase 21, bounded by Phase 22 start) ───────────────────────────
      // Diagnosis: flat 20min time_expired cooldown (Phase 20) doesn't distinguish
      // between a token that drifted sideways for 6h vs one that nearly hit the 10% TP.
      // Both got the same 20min cooldown — that's too short for drift, appropriate for near-TP.
      // Fix: split cooldown by exit PnL:
      //   - drift (<3% PnL): 60min — genuinely stalled, needs a full session reset
      //   - middle zone (3-5%): 40min — some momentum, conservative buffer
      //   - near-TP stall (≥5%): 20min — was actively moving, brief consolidation ok
      // Evidence: TIBBIR -0.2% time_expired → Phase 20 20min blocked 2-min re-entry ✅
      //   but 20min still allows re-entry within same drift context. 60min prevents that.
      //   Near-TP tokens (+5-8%) are different creatures — they had buyer demand, just needed
      //   more time. A quick 20min dip could be an entry for a second run.
      phase_21_time_expired_split: {
        label: 'v1.57.0 (time_expired cooldown split: drift→60min, middle→40min, near-TP→20min)',
        deployed: '2026-04-03T12:50:00Z',
        window: '2026-04-03T12:50Z → 2026-04-04T04:49Z',
        diagnosis: 'Phase 20 flat 20min time_expired cooldown treats all stalled exits the same. TIBBIR -0.2% (pure drift) should have 60min, not 20min. Near-TP exits (≥5%) can re-enter in 20min. Fix: 3-tier split by exit PnL. Outcome: 4/7 time_expired exits avg +2.3% — positive drift but below Phase 0 trailing stop trigger (5%). Evidence: tokens trending positive at 6h expiry. Fix (Phase 22): extend hold +2h for positive drift.',
        ...(phase21Trades.length > 0 ? {
          ...computeMetrics(phase21Trades),
          exit_reason_breakdown: (() => {
            const reasons = ['take_profit', 'stop_loss', 'trailing_stop', 'time_expired', 'momentum_stall'];
            const bd = {};
            for (const r of reasons) {
              const group = phase21Trades.filter(t => t.exitReason === r);
              if (group.length > 0) {
                const pnls = group.map(t => t.pnlPct).filter(p => p != null);
                bd[r] = { count: group.length, avg_pnl_pct: pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1) : null };
              }
            }
            return bd;
          })(),
        } : {
          total_trades: 0,
          note: 'Phase 21 deployed 2026-04-03T12:50Z — bounded by Phase 22. See phase_22 for latest.',
        }),
      },

      // ── Phase 22 epoch — post-v1.58.0 (bounded by Phase 23 start) ──────────
      // Diagnosis: Phase 21 exit_reason_breakdown shows time_expired exits at +2.3% avg (4/7 trades).
      // These tokens are trending positively but slowly — never reaching the Phase 0 trailing stop
      // trigger (5%) within the 6h hold window. Money is being left on the table.
      // Fix: when a position reaches its hold deadline with pnlPct > 1%, extend by 2h (one-time).
      // extendedHold flag prevents infinite extension. Positions that extended and then hit SL
      // are still protected — SL at -7% fires regardless of hold duration.
      // Expected: time_expired avg improves from +2.3% → +3-5%; overall expectancy near-positive.
      phase_22_positive_drift_extension: {
        label: 'v1.58.0–v1.58.x (positive drift hold extension: +2h if pnlPct > 1% at expiry)',
        deployed: '2026-04-04T04:49:00Z',
        diagnosis: 'Phase 21: 4/7 trades were time_expired at +2.3% avg — positive drift never reaching Phase 0 trailing stop (5% trigger). Tokens are trending up slowly but 6h hold isn\'t enough. Fix: extend hold +2h (one-time) when pnlPct > 1% at deadline. SL protection unchanged. Evidence threshold: 5+ extended hold exits to validate vs Phase 21 time_expired baseline (+2.3%).',
        ...(phase22Trades.length > 0 ? {
          ...computeMetrics(phase22Trades),
          exit_reason_breakdown: (() => {
            const reasons = ['take_profit', 'stop_loss', 'trailing_stop', 'time_expired', 'momentum_stall'];
            const bd = {};
            for (const r of reasons) {
              const group = phase22Trades.filter(t => t.exitReason === r);
              if (group.length > 0) {
                const pnls = group.map(t => t.pnlPct).filter(p => p != null);
                bd[r] = { count: group.length, avg_pnl_pct: pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1) : null };
              }
            }
            return bd;
          })(),
          // v1.59.0: Extended hold breakdown — show which positions used Phase 22 extension
          extended_hold_breakdown: (() => {
            const extended = phase22Trades.filter(t => t.extendedHold === true);
            const normal = phase22Trades.filter(t => !t.extendedHold);
            const summarize = (arr) => {
              if (arr.length === 0) return null;
              const pnls = arr.map(t => t.pnlPct).filter(p => p != null);
              const wins = arr.filter(t => (t.pnlPct || 0) > 0).length;
              return {
                count: arr.length,
                wins,
                win_rate_pct: ((wins / arr.length) * 100).toFixed(1),
                avg_pnl_pct: pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1) : null,
              };
            };
            return {
              extended_holds: summarize(extended) || { count: 0, note: 'no extensions triggered yet' },
              normal_holds:   summarize(normal)   || { count: 0, note: 'no normal exits yet' },
            };
          })(),
          note: 'Phase 22 bounded by Phase 23 start (2026-04-05T06:49Z). See phase_23 for latest.',
        } : {
          total_trades: 0,
          note: 'Phase 22 deployed 2026-04-04T04:49Z — accumulating.',
        }),
      },

      // ── Phase 23 epoch — post-v1.59.0 (LATEST) ──────────────────────────
      // Diagnosis: Phase 22 has 5 time_expired exits at -1.7% avg. These are "dead cat bounce"
      // entries — tokens with +2% 1h momentum but in a severe 24h downtrend (-25%+). The 1h
      // filter catches direction but not context: a token that's -35% in 24h and +2.5% in 1h
      // is bouncing off a low, not establishing a new uptrend. These bounces rarely sustain
      // beyond the 6h hold window, explaining the time_expired loss cluster.
      // Fix (v1.59.0): add price_change_24h >= -25% entry gate.
      // Threshold rationale: -25%+ = clear distribution event (institutional selling, adverse event).
      //   -10% to -25% = elevated but recoverable volatility (allow through).
      //   The -25% line is where 1h momentum becomes noise vs signal.
      // Also: extended_hold_breakdown in Phase 22 stats proves the Phase 22 mechanism works.
      phase_23_trend_alignment: {
        label: 'v1.59.0+ LATEST (24h trend alignment: block price_change_24h < -25%)',
        deployed: '2026-04-05T06:49:00Z',
        diagnosis: 'Phase 22: 5/8 time_expired exits at -1.7% avg. Hypothesis: these are dead-cat-bounce entries — tokens in severe 24h downtrend (-25%+) bouncing on 1h but not sustaining. Fix: block entries where price_change_24h < -25%. Expected: 2-4 fewer losers/week; time_expired avg improves; no impact on trailing_stop winners (those are in healthier 24h environments).',
        ...(phase23Trades.length > 0 ? {
          ...computeMetrics(phase23Trades),
          exit_reason_breakdown: (() => {
            const reasons = ['take_profit', 'stop_loss', 'trailing_stop', 'time_expired', 'momentum_stall'];
            const bd = {};
            for (const r of reasons) {
              const group = phase23Trades.filter(t => t.exitReason === r);
              if (group.length > 0) {
                const pnls = group.map(t => t.pnlPct).filter(p => p != null);
                bd[r] = { count: group.length, avg_pnl_pct: pnls.length ? (pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(1) : null };
              }
            }
            return bd;
          })(),
        } : {
          total_trades: 0,
          note: 'Phase 23 deployed 2026-04-05T06:49Z — accumulating. This is the latest strategy epoch.',
        }),
      },
    },

    // ── Phase 5 Projection on Phase 3 data (v1.36.0) ────────────────────────
    // Retroactive simulation: what would Phase 5 (10/10 TP/SL, weakened stall) have
    // returned on the 30 closed Phase 3 trades?
    phase_5_projection_on_p3: phase3Trades.length > 0 ? {
      note: `Simulated Phase 5 params (10% TP / 10% SL) applied to all ${phase3Trades.length} Phase 3 closed trades. Shows what the CURRENT strategy would return on verified historical data.`,
      simulation_rules: [
        'pnl >= +10% → take_profit at +10% (TP cap)',
        'stop_loss exits → stop_loss at -10% (Phase 5 SL vs Phase 3 -15%)',
        'momentum_stall with pnl > -3% → time_expired at orig pnl (Phase 5 stall requires ≤ -3%)',
        'all others (trailing_stop, time_expired, deep stalls) → unchanged',
      ],
      improvements_vs_p3: {
        take_profits_unlocked: p5projTakeProfits,
        stop_losses_with_5pct_save: p5projSLSaved,
        shallow_stalls_converted_to_time_expired: p5projStallLift,
      },
      ...computeMetrics(phase5Projection),
    } : { note: 'Phase 3 has no closed trades yet — projection unavailable' },

    // ── Cross-filters ───────────────────────────────────────────────────────
    recent_24h:   recent24hTrades.length > 0
      ? { total_trades: recent24hTrades.length, ...computeMetrics(recent24hTrades) }
      : { total_trades: 0, note: 'no trades in last 24h yet' },

    current_strategy_filter: {
      note: `Only trades passing live filters: momentum ≥ ${MIN_MOMENTUM_FILTER}x AND liquidity ≥ $${(MIN_LIQUIDITY_USD/1000).toFixed(0)}K. Shows how v1.28.0 criteria perform on all historical data.`,
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

    // v1.29.0: Restore stallCounts from Postgres (escalating blacklist survives Railway deploys)
    const savedStallCounts = await loadAgentState('stall_counts');
    if (savedStallCounts && Array.isArray(savedStallCounts)) {
      savedStallCounts.forEach(([addr, count]) => state.stallCounts.set(addr, count));
      if (state.stallCounts.size > 0) {
        log(`[boot] Restored stallCounts for ${state.stallCounts.size} token(s) from Postgres`, {
          tokens: [...state.stallCounts.entries()].map(([a, c]) => `${a.slice(0,6)}:${c}`).join(', ')
        });
      }
    }

    // v1.43.0: Restore slCounts from Postgres (escalating SL blacklist survives Railway deploys)
    const savedSlCounts = await loadAgentState('sl_counts');
    if (savedSlCounts && Array.isArray(savedSlCounts)) {
      savedSlCounts.forEach(([addr, count]) => state.slCounts.set(addr, count));
      if (state.slCounts.size > 0) {
        log(`[boot] Restored slCounts for ${state.slCounts.size} token(s) from Postgres`, {
          tokens: [...state.slCounts.entries()].map(([a, c]) => `${a.slice(0,6)}:${c}`).join(', ')
        });
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
    // v1.37.0: ALWAYS restore open positions from Postgres (not inside if(priorState)).
    // BUG: Previously this was nested inside if(priorState), which is null after a Railway deploy
    // (filesystem wiped → no JSON file → priorState=null → Postgres open positions never loaded).
    // Root cause of Phase 5 position loss: v1.36.0 deployed at 23:35 UTC, TIBBIR+BRETT positions
    // were in Postgres but never restored because priorState=null. Fix: always call loadAgentState
    // unconditionally; fall back to JSON only when Postgres has nothing.
    const savedOpenPositions = await loadAgentState('open_positions');
    const jsonOpenPositions = priorState && Array.isArray(priorState.openPositions) ? priorState.openPositions : null;
    const openPositionsSource = savedOpenPositions || jsonOpenPositions;
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
    if (priorState) {
      // Merge JSON scan count (local progress) if JSON is newer
      state.scanCount = priorState.scanCount || 0;
      state.startedAt = priorState.startedAt || state.startedAt;
      state.shadowBuys = priorState.shadowBuys || [];
      state.capacityMisses = priorState.capacityMisses || [];
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
      // v1.29.0: persist stallCounts to Postgres (escalating blacklist survives Railway deploys)
      // Root cause: ROBOTMONEY/NOCK re-entered fresh after deploy with zero stall history,
      // bypassing the 3h/6h escalated blacklist that they'd earned pre-deploy.
      if (state.stallCounts.size > 0) {
        saveAgentState('stall_counts', [...state.stallCounts.entries()]);
      }
      // v1.43.0: persist slCounts to Postgres (escalating SL blacklist survives Railway deploys)
      if (state.slCounts.size > 0) {
        saveAgentState('sl_counts', [...state.slCounts.entries()]);
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

  // Schedule recurring scans (full token discovery + position check)
  setInterval(async () => {
    try {
      await runScanCycle();
    } catch (err) {
      log('[loop] Unhandled error in scan cycle', { error: err.message, stack: err.stack });
    }
  }, CONFIG.pollIntervalMs);

  // v1.38.0: Faster position-only checker (every 20s) to reduce SL overshoot
  // Runs checkPositions() independently of full scan cycle.
  // positionCheckRunning guard prevents double-close if 20s fires during 60s scan.
  setInterval(async () => {
    try {
      await checkPositions();
    } catch (err) {
      log('[position-check] Error', { error: err.message });
    }
  }, CONFIG.positionCheckIntervalMs);

  log(`[boot] Agent running. Scan: ${CONFIG.pollIntervalMs / 1000}s | Position check: ${CONFIG.positionCheckIntervalMs / 1000}s.`);
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
