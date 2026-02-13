import { subscribe, publish } from '../queue.js';
import { updateOrderStatus } from '../db.js';

// Placeholder: simula payout PIX logo após pedido
export function startPayoutWorker() {
  subscribe('payout.requested', async (evt) => {
    setTimeout(async () => {
      await updateOrderStatus(evt.orderId, 'concluída', { txHash: `pix-sim-${evt.orderId}` });
      publish('payout.settled', {
        orderId: evt.orderId,
        pixStatus: 'concluída'
      });
    }, 3000);
  });
}
