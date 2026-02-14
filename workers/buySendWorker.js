import axios from 'axios';
import crypto from 'crypto';
import { subscribe } from '../queue.js';
import { getBuyOrder, updateBuyOrderStatus } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

function signHdRequest(payload) {
  if (!config.signerHmacSecret) return { headers: {} };
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(8).toString('hex');
  const raw = JSON.stringify(payload);
  const data = Buffer.concat([Buffer.from(`${ts}.${nonce}.`), Buffer.from(raw)]);
  const hmac = crypto.createHmac('sha256', config.signerHmacSecret).update(data).digest('hex');
  return {
    headers: {
      'x-ts': ts,
      'x-nonce': nonce,
      'x-signer-hmac': hmac,
      'Content-Type': 'application/json'
    }
  };
}

export function startBuySendWorker() {
  subscribe('buy.paid', async (evt) => {
    try {
      const order = await getBuyOrder(evt.buyOrderId);
      if (!order || order.status !== 'pago_pix') return;
      if (!config.signerUrl) {
        logger.error({ buyOrderId: order.id }, 'SIGNER_URL não configurado para envio on-chain');
        return;
      }
      const payload = {
        derivationIndex: config.buyHotDerivationIndex || 0,
        to: order.dest_address || order.dest_address,
        amount: String(order.crypto_amount || order.cryptoAmount),
        tokenContract: config.tronUsdtContract,
        idempotencyKey: `buy-${order.id}`
      };
      const signed = signHdRequest(payload);
      const resp = await axios.post(`${config.signerUrl}/hd/transfer`, payload, { headers: signed.headers });
      const txHash = resp.data?.txId || resp.data?.txHash;
      await updateBuyOrderStatus(order.id, 'enviado_onchain', { txHashOut: txHash });
      await updateBuyOrderStatus(order.id, 'concluída', { txHashOut: txHash });
    } catch (err) {
      logger.error({ err: err.response?.data || err.message, buyOrderId: evt.buyOrderId }, 'Erro ao enviar on-chain (buy)');
      await updateBuyOrderStatus(evt.buyOrderId, 'erro', { error: err.message });
    }
  });
}
