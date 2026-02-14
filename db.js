import fs from 'fs';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || config.databaseUrl,
  max: 10,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}

export async function createOrder(order) {
  const text = `
    INSERT INTO orders (id, status, amount_brl, btc_amount, fee_brl, payout_brl, address, asset, network, rate_locked, rate_lock_expires_at, created_at, pix_cpf, pix_phone, derivation_index)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING *`;
  const values = [
    order.id,
    order.status,
    order.amountBRL,
    order.btcAmount,
    order.feeBRL,
    order.payoutBRL,
    order.address,
    order.asset,
    order.network,
    order.rateLocked,
    order.rateLockExpiresAt,
    order.createdAt,
    order.pixCpf || null,
    order.pixPhone || null,
    order.derivationIndex ?? null
  ];
  await pool.query(text, values);
  await addEvent(order.id, 'order.created', { amountBRL: order.amountBRL, btcAmount: order.btcAmount });
}

export async function getOrder(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function getPendingOrders() {
  const { rows } = await pool.query("SELECT * FROM orders WHERE status = 'aguardando_deposito'");
  return rows;
}

export async function statsPixLast24h(pixCpf, pixPhone) {
  const params = [];
  const conds = [];
  if (pixCpf) {
    params.push(pixCpf);
    conds.push(`pix_cpf = $${params.length}`);
  }
  if (pixPhone) {
    params.push(pixPhone);
    conds.push(`pix_phone = $${params.length}`);
  }
  if (!conds.length) return { count: 0, total: 0 };
  const where = conds.join(' OR ');
  params.push(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_brl),0)::numeric AS total
     FROM orders
     WHERE (${where}) AND created_at >= $${params.length}`,
    params
  );
  return { count: rows[0]?.count ?? 0, total: Number(rows[0]?.total ?? 0) };
}

export async function countCompletedOrdersForPix(pixCpf, pixPhone) {
  const params = [];
  const conds = [];
  if (pixCpf) {
    params.push(pixCpf);
    conds.push(`pix_cpf = $${params.length}`);
  }
  if (pixPhone) {
    params.push(pixPhone);
    conds.push(`pix_phone = $${params.length}`);
  }
  if (!conds.length) return 0;
  const where = conds.join(' OR ');
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM orders
     WHERE (${where}) AND status = 'concluída'`,
    params
  );
  return rows[0]?.count ?? 0;
}

export async function updateOrderStatus(id, status, extra = {}) {
  const { txHash, error, depositTx, depositAmount } = extra;
  await pool.query(
    `UPDATE orders SET status = $2,
                       tx_hash = COALESCE($3, tx_hash),
                       error = COALESCE($4, error),
                       deposit_tx = COALESCE($5, deposit_tx),
                       deposit_amount = COALESCE($6, deposit_amount)
     WHERE id = $1`,
    [id, status, txHash || null, error || null, depositTx || null, depositAmount || null]
  );
  await addEvent(id, `order.${status}`, { txHash, error, depositTx, depositAmount });
}

export async function addEvent(orderId, type, payload) {
  await pool.query(
    `INSERT INTO order_events (id, order_id, type, payload) VALUES (gen_random_uuid(), $1, $2, $3)`,
    [orderId, type, payload]
  );
}

export async function hasEvent(orderId, type, field, value) {
  const { rows } = await pool.query(
    `SELECT 1 FROM order_events WHERE order_id = $1 AND type = $2 AND payload ->> $3 = $4 LIMIT 1`,
    [orderId, type, field, value]
  );
  return rows.length > 0;
}

export async function closePool() {
  await pool.end();
}

export async function nextDerivationIndex() {
  const { rows } = await pool.query('SELECT COALESCE(MAX(derivation_index), -1) + 1 AS idx FROM orders');
  return rows[0]?.idx ?? 0;
}

export async function getCursor(network) {
  const { rows } = await pool.query('SELECT last_block FROM onchain_cursor WHERE network = $1 LIMIT 1', [network]);
  return rows[0]?.last_block || null;
}

export async function saveCursor(network, lastBlock) {
  await pool.query(
    `INSERT INTO onchain_cursor (network, last_block) VALUES ($1,$2)
     ON CONFLICT (network) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`,
    [network, lastBlock]
  );
}

export async function createSweep(data) {
  const { rows } = await pool.query(
    `INSERT INTO sweeps (id, child_index, from_addr, to_addr, amount, status, order_id)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pending', $5)
     RETURNING *`,
    [data.childIndex, data.fromAddr, data.toAddr, data.amount, data.orderId || null]
  );
  return rows[0];
}

export async function listPendingSweeps() {
  const { rows } = await pool.query("SELECT * FROM sweeps WHERE status = 'pending'");
  return rows;
}

export async function markSweep(id, status, txHash = null) {
  await pool.query(
    `UPDATE sweeps SET status = $2, tx_hash = COALESCE($3, tx_hash), updated_at = now() WHERE id = $1`,
    [id, status, txHash]
  );
}

export async function ordersToSweep() {
  const { rows } = await pool.query(`
    SELECT o.*
    FROM orders o
    WHERE o.status = 'pago'
      AND o.derivation_index IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sweeps s
        WHERE s.order_id = o.id
          AND s.status IN ('pending','sent','confirmed')
      )
  `);
  return rows;
}

// Buy orders (on-ramp)
export async function createBuyOrder(buy) {
  const { rows } = await pool.query(
    `INSERT INTO buy_orders (id, status, amount_brl, fee_brl, payout_brl, crypto_amount, asset, dest_address, rate_locked, rate_lock_expires_at, pix_payload)
     VALUES (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      buy.status,
      buy.amountBRL,
      buy.feeBRL,
      buy.payoutBRL,
      buy.cryptoAmount,
      buy.asset,
      buy.destAddress,
      buy.rateLocked,
      buy.rateLockExpiresAt,
      buy.pixPayload || null
    ]
  );
  return rows[0];
}

export async function getBuyOrder(id) {
  const { rows } = await pool.query('SELECT * FROM buy_orders WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function updateBuyOrderStatus(id, status, extra = {}) {
  const { txHashOut, error } = extra;
  await pool.query(
    `UPDATE buy_orders SET status = $2,
                            tx_hash_out = COALESCE($3, tx_hash_out),
                            error = COALESCE($4, error),
                            updated_at = now()
     WHERE id = $1`,
    [id, status, txHashOut || null, error || null]
  );
}

export async function addBuyEvent(buyOrderId, type, payload) {
  await pool.query(
    `INSERT INTO buy_order_events (id, buy_order_id, type, payload)
     VALUES (gen_random_uuid(), $1, $2, $3)`,
    [buyOrderId, type, payload]
  );
}

export async function listPendingBuys() {
  const { rows } = await pool.query(
    `SELECT * FROM buy_orders WHERE status = 'pago_pix'`
  );
  return rows;
}
