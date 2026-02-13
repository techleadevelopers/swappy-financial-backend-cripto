import express from 'express';
import axios from 'axios';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { z } from 'zod';
import { config } from './config.js';
import { publish } from './queue.js';
import { getCachedPrice } from './workers/priceWorker.js';
import { createOrder, getOrder, updateOrderStatus } from './db.js';
import { httpLogger } from './logger.js';

export const app = express();
app.use(helmet());
app.use(rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax
}));
app.use(cors());
app.use(express.json());
app.use(httpLogger);

const orderLimiter = rateLimit({
  windowMs: config.orderRateLimitWindowMs,
  max: config.orderRateLimitMax,
  message: 'Too many orders created, try again later'
});

// CORS restrito (lista separada por vírgula no .env)
const allowed = config.allowedOrigins.includes('*')
  ? ['http://localhost:5173']
  : config.allowedOrigins;
app.use(cors({
  origin: (origin, cb) => {
    if (allowed.includes('*')) return cb(null, true);
    if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed'));
  }
}));

// Preço USDT/BRL
app.get('/api/price', async (_req, res) => {
  try {
    const { data } = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl,usd'
    );
    res.json({ brl: data.tether.brl });
  } catch (err) {
    res.status(500).json({ error: 'API error' });
  }
});

// Criar ordem
app.post('/api/order', orderLimiter, async (req, res) => {
  const OrderSchema = z.object({
    amountBRL: z.number().positive(),
    address: z.string().min(1),
    paymentMethod: z.string().optional(),
    network: z.string().optional(),
    asset: z.string().optional(),
    pixCpf: z.string().optional(),
    pixPhone: z.string().optional(),
  });

  const parseResult = OrderSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Parâmetros inválidos', details: parseResult.error.issues });
  }
  const { amountBRL, address, network = 'ERC20', asset = 'USDT', pixCpf, pixPhone } = parseResult.data;

  if (amountBRL < config.orderMinBrl || amountBRL > config.orderMaxBrl) {
    return res.status(400).json({ error: `Valor fora dos limites (${config.orderMinBrl} - ${config.orderMaxBrl} BRL)` });
  }

  const isEth = /^0x[a-fA-F0-9]{40}$/.test(address);
  const isBtc = /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{20,}$/i.test(address);
  if (!isEth && !isBtc) {
    return res.status(400).json({ error: 'Endereço inválido (BTC bech32/legacy ou Ethereum 0x...)' });
  }

  const btcRate = await getCachedPrice();
  const btcAmount = amountBRL / btcRate; // mantém nome legado, mas representa USDT->BRL
  const id = uuidv4();

  const order = {
    id,
    status: 'aguardando_deposito',
    amountBRL,
    btcAmount,
    address,
    asset,
    network,
    rateLocked: btcRate,
    rateLockExpiresAt: new Date(Date.now() + config.rateLockSec * 1000),
    createdAt: new Date(),
    pixKey: 'chavepix@nexswap.com',
    qrCodeUrl: '/images/qrcode.png',
    pixCpf,
    pixPhone
  };

  await createOrder(order);
  publish('order.created', order);

  res.json({
    orderId: id,
    btcAmount,
    rate: btcRate,
    status: order.status,
    pixKey: order.pixKey,
    qrCodeUrl: order.qrCodeUrl
  });
});

// Consultar status
app.get('/api/order/:id', (req, res) => {
  getOrder(req.params.id)
    .then(order => {
      if (!order) return res.status(404).json({ error: 'Ordem não encontrada' });
      res.json(order);
    })
    .catch(() => res.status(500).json({ error: 'Erro ao buscar ordem' }));
});

// Registrar depósito detectado (stub)
app.post('/api/order/:id/deposit', async (req, res) => {
  const DepositSchema = z.object({
    txHash: z.string().min(3),
    amount: z.number().positive()
  });
  const parsed = DepositSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payload inválido', details: parsed.error.issues });
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Ordem não encontrada' });
  if (order.status !== 'aguardando_deposito') {
    return res.status(400).json({ error: `Status atual não permite depósito: ${order.status}` });
  }
  await updateOrderStatus(order.id, 'pago', { depositTx: parsed.data.txHash, depositAmount: parsed.data.amount });
  publish('onchain.detected', { orderId: order.id, txHash: parsed.data.txHash, amount: parsed.data.amount });
  res.json({ ok: true });
});

// Registrar payout PIX (stub)
app.post('/api/order/:id/payout', async (req, res) => {
  const PayoutSchema = z.object({
    providerId: z.string().min(1),
    status: z.enum(['concluída', 'erro']),
    error: z.string().optional()
  });
  const parsed = PayoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payload inválido', details: parsed.error.issues });
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Ordem não encontrada' });
  if (order.status !== 'pago') {
    return res.status(400).json({ error: `Status atual não permite payout: ${order.status}` });
  }
  if (parsed.data.status === 'concluída') {
    await updateOrderStatus(order.id, 'concluída', { txHash: parsed.data.providerId });
  } else {
    await updateOrderStatus(order.id, 'erro', { error: parsed.data.error || 'payout erro' });
  }
  publish('payout.settled', { orderId: order.id, providerId: parsed.data.providerId, status: parsed.data.status });
  res.json({ ok: true });
});

// Webhook PIX (PagBank) stub com verificação HMAC
app.post('/api/pix/webhook', express.raw({ type: '*/*' }), (req, res) => {
  if (!config.webhookSecret) return res.status(400).json({ error: 'WEBHOOK_SECRET não configurado' });
  const signature = req.headers['x-pagbank-signature'];
  const hmac = crypto.createHmac('sha256', config.webhookSecret).update(req.body).digest('hex');
  if (signature !== hmac) return res.status(401).json({ error: 'Assinatura inválida' });
  res.json({ received: true });
});

// SSE de status
app.get('/api/order/:id/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  let lastStatus = null;
  const interval = setInterval(async () => {
    const order = await getOrder(req.params.id);
    if (!order) return;
    if (order.status !== lastStatus) {
      lastStatus = order.status;
      res.write(`data: ${JSON.stringify({ status: order.status, txHash: order.tx_hash || order.txHash })}\n\n`);
    }
  }, 2000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// Health / readiness
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/readyz', async (_req, res) => {
  try {
    await getOrder('00000000-0000-0000-0000-000000000000');
    res.json({ ok: true, db: true });
  } catch {
    res.status(500).json({ ok: false, db: false });
  }
});
