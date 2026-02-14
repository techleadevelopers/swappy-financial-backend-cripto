import axios from 'axios';
import crypto from 'crypto';
import TronWebPkg from 'tronweb';
import { listPendingSweeps, markSweep, createSweep, ordersToSweep } from '../db.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { deriveTronAddress } from '../tron.js';

const TronWeb = TronWebPkg?.TronWeb || TronWebPkg?.default?.TronWeb || TronWebPkg;
const tronWeb = new TronWeb({
  fullHost: config.tronFullNodeUrl || 'https://api.trongrid.io',
  solidityNode: config.tronSolidityUrl || config.tronFullNodeUrl || 'https://api.trongrid.io',
  eventServer: config.tronSolidityUrl || config.tronFullNodeUrl || 'https://api.trongrid.io',
  privateKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
});

function signBody(body) {
  if (!config.signerHmacSecret) return null;
  return crypto.createHmac('sha256', config.signerHmacSecret).update(JSON.stringify(body)).digest('hex');
}

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
    },
    body: raw
  };
}

async function ensureGas(fromAddr) {
  try {
    const balanceSun = await tronWeb.trx.getBalance(fromAddr);
    const balanceTrx = balanceSun / 1e6;
    return balanceTrx >= config.tronGasReserveTrx;
  } catch (err) {
    logger.error({ err, fromAddr }, 'Erro ao checar saldo TRX');
    return false;
  }
}

export function startSweepWorker() {
  // Modo stub opcional
  if (!config.enableSweepWorker && config.enableSweepStub) {
    setInterval(async () => {
      try {
        const pending = await listPendingSweeps();
        for (const sweep of pending) {
          const txHash = `sweep-sim-${sweep.id}`;
          await markSweep(sweep.id, 'sent', txHash);
          logger.info({ sweepId: sweep.id, txHash }, 'Sweep simulado concluído');
        }
      } catch (err) {
        logger.error({ err }, 'Erro no sweep stub');
      }
    }, config.sweepFrequencyMs || 15000);
    return;
  }

  if (!config.signerUrl || !config.treasuryHot) {
    logger.warn('Sweep worker não iniciado: SIGNER_URL ou TREASURY_HOT não configurados');
    return;
  }

  setInterval(async () => {
    try {
      // Criar sweeps para ordens pagas que ainda não têm sweep em andamento
      const toSweep = await ordersToSweep();
      for (const order of toSweep) {
        const childAddr = deriveTronAddress(order.derivation_index);
        await createSweep({
          childIndex: order.derivation_index,
          fromAddr: childAddr,
          toAddr: config.treasuryHot,
          amount: Number(order.deposit_amount || order.depositAmount || order.btc_amount || order.btcAmount || 0),
          orderId: order.id
        });
      }

      const pending = await listPendingSweeps();
      for (const sweep of pending) {
        const fromAddr = sweep.from_addr || sweep.fromAddr;
        if (!(await ensureGas(fromAddr))) {
          logger.warn({ sweepId: sweep.id }, 'Saldo TRX insuficiente para fee, pulando sweep');
          continue;
        }

        const payload = {
          derivationIndex: sweep.child_index || sweep.childIndex || 0,
          to: sweep.to_addr || sweep.toAddr || config.treasuryHot,
          amount: String(Number(sweep.amount)),
          tokenContract: config.tronUsdtContract,
          idempotencyKey: sweep.id
        };
        const signed = signHdRequest(payload);
        try {
          const resp = await axios.post(`${config.signerUrl}/hd/transfer`, payload, {
            headers: signed.headers
          });
          const txHash = resp.data?.txId || resp.data?.txHash || `sweep-${sweep.id}`;
          await markSweep(sweep.id, 'sent', txHash);
          logger.info({ sweepId: sweep.id, txHash }, 'Sweep enviado via signer HD');
        } catch (err) {
          logger.error({ err: err.response?.data || err.message, sweepId: sweep.id }, 'Erro ao chamar signer HD');
          await markSweep(sweep.id, 'failed', null);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Erro ao processar sweeps');
    }
  }, config.sweepFrequencyMs || 15000);
}
