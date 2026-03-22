/**
 * db.js — Postgres persistence for sol-evm-agent
 *
 * Provides durable storage for paper trades and decisions so state
 * survives Railway container restarts. Agent-loop.js uses JSON file
 * for in-process speed; this module provides restart-proof backup.
 *
 * Tables:
 *   paper_trades — one row per closed paper position
 *   decisions    — one row per trade decision (last 2000 kept)
 *   agent_state  — kv_store for circuit breaker + scan count
 */

import pkg from 'pg';
const { Pool } = pkg;

let pool = null;
let dbAvailable = false;

// ─── Init ─────────────────────────────────────────────────────────────────────

export async function initDB() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.log('[db] No DATABASE_URL — Postgres persistence disabled, using file-only');
    return false;
  }

  try {
    pool = new Pool({
      connectionString: url,
      ssl: url.includes('railway.internal') ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      max: 5,
    });

    // Test connection
    await pool.query('SELECT 1');

    // Create tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS paper_trades (
        id TEXT PRIMARY KEY,
        token_address TEXT,
        symbol TEXT,
        entry_time TIMESTAMPTZ,
        exit_time TIMESTAMPTZ,
        entry_price NUMERIC,
        exit_reason TEXT,
        pnl_pct NUMERIC,
        entry_signal JSONB,
        exit_params JSONB,
        position_size_usd NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS decisions (
        id SERIAL PRIMARY KEY,
        action TEXT,
        reason TEXT,
        token TEXT,
        symbol TEXT,
        score INTEGER,
        risk_label TEXT,
        momentum NUMERIC,
        liquidity NUMERIC,
        hour_utc INTEGER,
        hour_status TEXT,
        ts TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_state (
        key TEXT PRIMARY KEY,
        value JSONB,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Keep decisions table bounded (delete oldest if > 2000 rows)
    await pool.query(`
      DELETE FROM decisions WHERE id IN (
        SELECT id FROM decisions ORDER BY id ASC
        LIMIT GREATEST(0, (SELECT COUNT(*) FROM decisions) - 2000)
      )
    `);

    dbAvailable = true;
    console.log('[db] Postgres connected and tables ready');
    return true;
  } catch (err) {
    console.error('[db] Postgres init failed — file-only mode:', err.message);
    dbAvailable = false;
    return false;
  }
}

// ─── Trades ───────────────────────────────────────────────────────────────────

/**
 * Persist a closed paper trade.
 * Call this in closePosition() after marking status = paper_closed.
 */
export async function saveTrade(pos) {
  if (!dbAvailable || !pool) return;
  try {
    await pool.query(`
      INSERT INTO paper_trades (
        id, token_address, symbol, entry_time, exit_time,
        entry_price, exit_reason, pnl_pct, entry_signal, exit_params, position_size_usd
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (id) DO UPDATE SET
        exit_time = EXCLUDED.exit_time,
        exit_reason = EXCLUDED.exit_reason,
        pnl_pct = EXCLUDED.pnl_pct
    `, [
      pos.id || (pos.tokenAddress + '_' + pos.entryTime),
      pos.tokenAddress,
      pos.symbol,
      pos.entryTime,
      pos.exitTime,
      pos.entryPrice,
      pos.exitReason,
      pos.pnlPct,
      JSON.stringify(pos.entrySignal || {}),
      JSON.stringify(pos.exitParams || {}),
      pos.positionSizeUSD,
    ]);
  } catch (err) {
    console.error('[db] saveTrade error:', err.message);
  }
}

/**
 * Load all closed paper trades from Postgres.
 * Used on boot to restore closedPositions array.
 */
export async function loadTrades() {
  if (!dbAvailable || !pool) return [];
  try {
    const res = await pool.query(`
      SELECT * FROM paper_trades ORDER BY exit_time DESC LIMIT 200
    `);
    return res.rows.map(r => ({
      id:              r.id,
      tokenAddress:    r.token_address,
      symbol:          r.symbol,
      entryTime:       r.entry_time?.toISOString(),
      exitTime:        r.exit_time?.toISOString(),
      entryPrice:      r.entry_price ? parseFloat(r.entry_price) : null,
      exitReason:      r.exit_reason,
      pnlPct:          r.pnl_pct ? parseFloat(r.pnl_pct) : null,
      entrySignal:     r.entry_signal,
      exitParams:      r.exit_params,
      positionSizeUSD: r.position_size_usd ? parseFloat(r.position_size_usd) : 50,
      status:          'paper_closed',
    }));
  } catch (err) {
    console.error('[db] loadTrades error:', err.message);
    return [];
  }
}

// ─── Decisions ────────────────────────────────────────────────────────────────

/**
 * Persist a trade decision (BUY or SKIP).
 * Fire-and-forget — don't await this in hot path.
 */
export function saveDecision(d) {
  if (!dbAvailable || !pool) return;
  pool.query(`
    INSERT INTO decisions (action, reason, token, symbol, score, risk_label, momentum, liquidity, hour_utc, hour_status, ts)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `, [
    d.action,
    d.reason,
    d.token,
    d.symbol,
    d.score ?? null,
    d.risk_label ?? null,
    d.momentum ?? null,
    d.liquidity ?? null,
    d.hour_utc ?? null,
    d.hour_status ?? null,
    d.timestamp ? new Date(d.timestamp) : new Date(),
  ]).catch(err => console.error('[db] saveDecision error:', err.message));
}

/**
 * Load recent decisions from Postgres.
 * Used on boot to restore the decisions log.
 */
export async function loadDecisions(limit = 100) {
  if (!dbAvailable || !pool) return [];
  try {
    const res = await pool.query(`
      SELECT * FROM decisions ORDER BY ts DESC LIMIT $1
    `, [limit]);
    return res.rows.map(r => ({
      action:      r.action,
      reason:      r.reason,
      token:       r.token,
      symbol:      r.symbol,
      score:       r.score,
      risk_label:  r.risk_label,
      momentum:    r.momentum ? parseFloat(r.momentum) : null,
      liquidity:   r.liquidity ? parseFloat(r.liquidity) : null,
      hour_utc:    r.hour_utc,
      hour_status: r.hour_status,
      timestamp:   r.ts?.toISOString(),
    })).reverse(); // oldest first for display
  } catch (err) {
    console.error('[db] loadDecisions error:', err.message);
    return [];
  }
}

// ─── Agent State (CB + scan count) ───────────────────────────────────────────

export async function saveAgentState(key, value) {
  if (!dbAvailable || !pool) return;
  try {
    await pool.query(`
      INSERT INTO agent_state (key, value, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `, [key, JSON.stringify(value)]);
  } catch (err) {
    console.error('[db] saveAgentState error:', err.message);
  }
}

export async function loadAgentState(key) {
  if (!dbAvailable || !pool) return null;
  try {
    const res = await pool.query('SELECT value FROM agent_state WHERE key = $1', [key]);
    return res.rows[0]?.value ?? null;
  } catch (err) {
    console.error('[db] loadAgentState error:', err.message);
    return null;
  }
}

export { dbAvailable };
