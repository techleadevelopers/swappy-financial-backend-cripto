import axios from 'axios';
import { subscribe, publish } from '../queue.js';
import { updateOrderStatus, getOrder } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export function startPayoutWorker() {
  subscribe('payout.requested', async (evt) => {
    try {
      const order = await getOrder(evt.orderId);
      if (!order) return;
      if (order.status !== 'pago') return;
      if (!config.pagSeguroToken) {
        logger.warn({ orderId: order.id }, 'PagBank token não configurado, simulando payout');
        await updateOrderStatus(order.id, 'concluída', { txHash: `pix-sim-${order.id}` });
        publish('payout.settled', { orderId: order.id, pixStatus: 'concluída' });
        return;
      }
      const payload = {
        txId: order.id,
        value: { currency: 'BRL', amount: Number(order.amount_brl || order.amount_brl) || Number(order.amount_brl) || 0 },
        payer: { name: 'Cliente', taxId: order.pix_cpf || '00000000000' },
        key: order.pix_phone || order.pix_cpf || 'chave@pix.com',
        description: 'Off-ramp USDT->PIX'
      };
      const resp = await axios.post(
        `${config.pagSeguroBaseUrl}/instant-payments`,
        payload,
        { headers: { Authorization: `Bearer ${config.pagSeguroToken}` } }
      );
      const providerId = resp.data?.id || `pagbank-${order.id}`;
      await updateOrderStatus(order.id, 'concluída', { txHash: providerId });
      publish('payout.settled', { orderId: order.id, pixStatus: 'concluída', providerId });
    } catch (err) {
      logger.error({ err, orderId: evt.orderId }, 'Erro no payout');
      await updateOrderStatus(evt.orderId, 'erro', { error: err.message });
    }
  });
}
