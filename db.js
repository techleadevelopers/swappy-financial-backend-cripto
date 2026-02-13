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
    INSERT INTO orders (id, status, amount_brl, btc_amount, address, asset, network, rate_locked, rate_lock_expires_at, created_at, pix_cpf, pix_phone)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
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
    order.pixPhone || null
  ];
  await pool.query(text, values);
  await addEvent(order.id, 'order.created', { amountBRL: order.amountBRL, btcAmount: order.btcAmount });
}

export async function getOrder(id) {
  const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
  return rows[0] || null;
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
