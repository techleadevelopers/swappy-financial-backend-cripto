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
    INSERT INTO orders (id, status, amount_brl, btc_amount, address, asset, network, rate_locked, rate_lock_expires_at, created_at, pix_cpf, pix_phone, derivation_index)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *`;
  const values = [
    order.id,
    order.status,
    order.amountBRL,
    order.btcAmount,
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
    `INSERT INTO sweeps (id, child_index, from_addr, to_addr, amount, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pending')
     RETURNING *`,
    [data.childIndex, data.fromAddr, data.toAddr, data.amount]
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
