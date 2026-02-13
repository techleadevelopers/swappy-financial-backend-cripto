import TronWebPkg from 'tronweb';
import { publish } from '../queue.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { updateOrderStatus, getPendingOrders, getCursor, saveCursor } from '../db.js';

const TronWeb = TronWebPkg?.TronWeb || TronWebPkg?.default?.TronWeb || TronWebPkg;
const tronWeb = new TronWeb({
  fullHost: config.tronFullNodeUrl || 'https://api.trongrid.io',
  solidityNode: config.tronSolidityUrl || config.tronFullNodeUrl || 'https://api.trongrid.io',
  eventServer: config.tronSolidityUrl || config.tronFullNodeUrl || 'https://api.trongrid.io',
  privateKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
});

let polling = false;

async function processTransferEvents(ordersByAddress, latestConfirmedBlock) {
  if (!config.tronUsdtContract) {
    logger.warn('TRON_USDT_CONTRACT não configurado; pulando listener on-chain');
    return;
  }
  let cursor = await getCursor('TRON');
  const startBlock = cursor != null ? cursor + 1 : Math.max(0, latestConfirmedBlock - 2000);

  for (let blockNumber = startBlock; blockNumber <= latestConfirmedBlock; blockNumber++) {
    let fingerprint = null;
    do {
      const result = await tronWeb.event.getEventsByContractAddress(config.tronUsdtContract, {
        eventName: 'Transfer',
        blockNumber,
        orderBy: 'block_timestamp,asc',
        onlyConfirmed: true,
        limit: 200,
        fingerprint
      });
      const events = result?.data || [];
      for (const ev of events) {
        const toAddr = tronWeb.address.fromHex(ev.result.to);
        const order = ordersByAddress.get(toAddr);
        if (!order || (order.status && order.status !== 'aguardando_deposito')) continue;
        const decimals = config.tronUsdtDecimals || 6;
        const amount = Number(ev.result.value) / (10 ** decimals);
        const expected = Number(order.btc_amount ?? order.btcAmount ?? 0);
        if (amount + 1e-6 < expected) continue;
        const confs = latestConfirmedBlock - ev.block_number;
        if (confs < 0) continue;
        await updateOrderStatus(order.id, 'pago', { depositTx: ev.transaction_id, depositAmount: amount });
        publish('onchain.detected', { orderId: order.id, txHash: ev.transaction_id, amount });
        publish('payout.requested', { orderId: order.id });
        ordersByAddress.delete(toAddr);
      }
      fingerprint = result?.meta?.fingerprint;
    } while (fingerprint);
    await saveCursor('TRON', blockNumber);
  }
}

export function startOnchainWorker() {
  setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const pending = await getPendingOrders();
      const tronPending = pending.filter(o => (o.network || '').toUpperCase() === 'TRON');
      const latest = await tronWeb.trx.getCurrentBlock();
      const latestNumber = latest.block_header.raw_data.number;
      const latestConfirmedBlock = Math.max(0, latestNumber - config.tronConfirmations);

      if (!tronPending.length) {
        await saveCursor('TRON', latestConfirmedBlock);
        return;
      }

      const ordersByAddress = new Map(tronPending.map(o => [o.address, o]));
      await processTransferEvents(ordersByAddress, latestConfirmedBlock);
    } catch (err) {
      logger.error({ err }, 'Erro ao processar eventos TRON');
    } finally {
      polling = false;
    }
  }, 10_000);
}
