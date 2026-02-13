import { listPendingSweeps, markSweep } from '../db.js';
import { logger } from '../logger.js';

// Stub: marca sweeps pendentes como "sent" com tx_hash simulado.
// Em produção, este worker deve:
//  - consultar saldo dos endereços,
//  - chamar o serviço signer (HSM/MPC) para assinar,
//  - broadcastar no nó TRON,
//  - atualizar status/tx_hash.

export function startSweepWorker() {
  setInterval(async () => {
    try {
      const pending = await listPendingSweeps();
      for (const sweep of pending) {
        const txHash = `sweep-sim-${sweep.id}`;
        await markSweep(sweep.id, 'sent', txHash);
        logger.info({ sweepId: sweep.id, txHash }, 'Sweep simulado concluído');
      }
    } catch (err) {
      logger.error({ err }, 'Erro ao processar sweeps');
    }
  }, 15_000);
}
