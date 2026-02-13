import { subscribe, publish } from '../queue.js';
import { updateOrderStatus } from '../db.js';

// Placeholder: simula detecção on-chain após delay
export function startOnchainWorker() {
  subscribe('order.created', async (order) => {
    setTimeout(async () => {
      const txHash = `simulated-${order.id}`;
      await updateOrderStatus(order.id, 'pago', { depositTx: txHash, depositAmount: order.btcAmount });
      publish('onchain.detected', {
        orderId: order.id,
        txHash,
        amount: order.btcAmount
      });
      publish('payout.requested', { orderId: order.id });
    }, 5000);
  });
}
