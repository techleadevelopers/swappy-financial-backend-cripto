import TronWebPkg from 'tronweb';
import { subscribe, publish } from '../queue.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { updateOrderStatus, getPendingOrders } from '../db.js';

const TronWeb = TronWebPkg?.TronWeb || TronWebPkg?.default?.TronWeb || TronWebPkg;
const tronWeb = new TronWeb({
  fullHost: config.tronFullNodeUrl || 'https://api.trongrid.io',
  solidityNode: config.tronSolidityUrl || config.tronFullNodeUrl || 'https://api.trongrid.io',
  eventServer: config.tronSolidityUrl || config.tronFullNodeUrl || 'https://api.trongrid.io',
  privateKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
});

const watchers = new Map(); // orderId -> intervalId

async function checkOrderOnchain(order) {
  if (order.status !== 'aguardando_deposito' || order.network !== 'TRON') return;
  try {
    const latest = await tronWeb.trx.getCurrentBlock();
    const latestNumber = latest.block_header.raw_data.number;
    const events = await tronWeb.getEventResult(config.tronUsdtContract, {
      eventName: 'Transfer',
      sort: 'block_timestamp',
      limit: 200
    });
    for (const ev of events) {
      const toBase58 = tronWeb.address.fromHex(ev.result.to);
      if (toBase58 !== order.address) continue;
      const amount = Number(ev.result.value) / (10 ** config.tronUsdtDecimals);
      const confs = latestNumber - ev.block_number;
      if (confs < config.tronConfirmations) continue;
      if (amount + 1e-6 < Number(order.btc_amount || order.btcAmount)) continue;
      await updateOrderStatus(order.id, 'pago', { depositTx: ev.transaction_id, depositAmount: amount });
      publish('onchain.detected', { orderId: order.id, txHash: ev.transaction_id, amount });
      publish('payout.requested', { orderId: order.id });
      stopWatcher(order.id);
      return;
    }
  } catch (err) {
    logger.error({ err, orderId: order.id }, 'Erro ao checar TRON events');
  }
}

function startWatcher(order) {
  if (watchers.has(order.id)) return;
  const intervalId = setInterval(() => checkOrderOnchain(order), 10_000);
  watchers.set(order.id, intervalId);
}

function stopWatcher(orderId) {
  const id = watchers.get(orderId);
  if (id) clearInterval(id);
  watchers.delete(orderId);
}

export function startOnchainWorker() {
  subscribe('order.created', async (order) => {
    if (order.network === 'TRON') startWatcher(order);
  });
  // carregar ordens pendentes na inicialização
  getPendingOrders().then(orders => {
    orders.filter(o => o.network === 'TRON').forEach(startWatcher);
  }).catch(err => logger.error({ err }, 'Erro ao carregar pendentes'));
}
