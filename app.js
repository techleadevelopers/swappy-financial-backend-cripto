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
import { createOrder, getOrder, updateOrderStatus, nextDerivationIndex, createSweep, addEvent, hasEvent, statsPixLast24h, countCompletedOrdersForPix, createBuyOrder, getBuyOrder, updateBuyOrderStatus } from './db.js';
import { httpLogger } from './logger.js';
import { deriveTronAddress, isTronAddress, tronWeb } from './tron.js';

export const app = express();
app.set('trust proxy', 1); // necessário para X-Forwarded-For em ambiente com proxy (Railway/NGINX)
app.use(helmet());
app.use(rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax
}));
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));
app.use(httpLogger);

function isValidHmac(secret, raw, signature) {
  if (!secret || !signature) return false;
  const digest = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const digBuf = Buffer.from(digest, 'hex');
  return sigBuf.length === digBuf.length && crypto.timingSafeEqual(sigBuf, digBuf);
}

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

// Criar ordem BUY (PIX -> USDT)
app.post('/api/buy', async (req, res) => {
  const BuySchema = z.object({
    amountBRL: z.number().positive(),
    asset: z.enum(['USDT', 'BTC']).default('USDT'),
    address: z.string().min(10),
    pixCpf: z.string().optional(),
    pixPhone: z.string().optional()
  }).refine(data => data.pixCpf || data.pixPhone, {
    message: 'pixCpf ou pixPhone é obrigatório',
    path: ['pix']
  });
  const parsed = BuySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Parâmetros inválidos', details: parsed.error.issues });
  const { amountBRL, asset, address, pixCpf, pixPhone } = parsed.data;

  if (asset !== 'USDT') return res.status(400).json({ error: 'Asset não suportado nesta fase (apenas USDT)' });
  // Validar endereço TRON USDT
  if (!isTronAddress(address)) return res.status(400).json({ error: 'Endereço TRON inválido' });

  if (amountBRL < config.orderMinBrl || amountBRL > config.orderMaxBrl) {
    return res.status(400).json({ error: `Valor fora dos limites (${config.orderMinBrl} - ${config.orderMaxBrl} BRL)` });
  }

  const rate = await getCachedPrice();
  const feeBRL = Math.max(config.feeMinBrl, amountBRL * (config.feeBps / 10_000));
  const payoutBRL = amountBRL - feeBRL;
  if (payoutBRL <= 0) return res.status(400).json({ error: 'Valor insuficiente após taxa' });
  const cryptoAmount = payoutBRL / rate;

  const buy = await createBuyOrder({
    status: 'aguardando_pix',
    amountBRL,
    feeBRL,
    payoutBRL,
    cryptoAmount,
    asset,
    destAddress: address,
    rateLocked: rate,
    rateLockExpiresAt: new Date(Date.now() + config.rateLockSec * 1000),
    pixPayload: { pixKey: 'chavepix@nexswap.com', qrCodeUrl: '/images/qrcode.png' }
  });

  publish('buy.created', buy);

  res.json({
    buyId: buy.id,
    status: buy.status,
    feeBRL,
    payoutBRL,
    rate,
    cryptoAmount,
    pixKey: buy.pix_payload?.pixKey || 'chavepix@nexswap.com',
    qrCodeUrl: buy.pix_payload?.qrCodeUrl || '/images/qrcode.png'
  });
});

// Consultar buy
app.get('/api/buy/:id', async (req, res) => {
  const buy = await getBuyOrder(req.params.id);
  if (!buy) return res.status(404).json({ error: 'Compra não encontrada' });
  res.json(buy);
});

// SSE status buy
app.get('/api/buy/:id/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.flushHeaders();

  let lastStatus = null;
  const interval = setInterval(async () => {
    const buy = await getBuyOrder(req.params.id);
    if (!buy) return;
    if (buy.status !== lastStatus) {
      lastStatus = buy.status;
      res.write(`data: ${JSON.stringify({ status: buy.status, txHash: buy.tx_hash_out })}\n\n`);
    }
  }, 2000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// Criar ordem
app.post('/api/order', orderLimiter, async (req, res) => {
  const OrderSchema = z.object({
    amountBRL: z.number().positive(),
    address: z.string().min(1).optional(),
    paymentMethod: z.string().optional(),
    network: z.string().optional(),
    asset: z.string().optional(),
    pixCpf: z.string().optional(),
    pixPhone: z.string().optional(),
  }).refine(data => data.pixCpf || data.pixPhone, {
    message: 'pixCpf ou pixPhone é obrigatório',
    path: ['pix']
  });

  const parseResult = OrderSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Parâmetros inválidos', details: parseResult.error.issues });
  }
  const { amountBRL, address, network = 'TRON', asset = 'USDT', pixCpf, pixPhone } = parseResult.data;
  const normalizedNetwork = network.toUpperCase();
  const normalizedAsset = asset.toUpperCase();

  if (normalizedNetwork !== 'TRON' || normalizedAsset !== 'USDT') {
    return res.status(400).json({ error: 'Somente pedidos TRON/USDT sÃ£o suportados' });
  }

  if (amountBRL < config.orderMinBrl || amountBRL > config.orderMaxBrl) {
    return res.status(400).json({ error: `Valor fora dos limites (${config.orderMinBrl} - ${config.orderMaxBrl} BRL)` });
  }

  // Velocity / abuso por chave PIX
  const pixStats = await statsPixLast24h(pixCpf, pixPhone);
  if (pixStats.count >= config.pixMaxOrders24h) {
    return res.status(429).json({ error: 'Limite de ordens por 24h excedido para esta chave PIX' });
  }
  if (pixStats.total + amountBRL > config.pixMaxBrl24h) {
    return res.status(429).json({ error: 'Limite de valor diário por chave PIX excedido' });
  }

  let depositAddress = address;
  let derivationIndex = null;
  if (!depositAddress) {
    derivationIndex = await nextDerivationIndex();
    try {
      depositAddress = deriveTronAddress(derivationIndex);
    } catch (e) {
      return res.status(500).json({ error: 'Falha ao derivar endereço TRON', details: e.message });
    }
  } else if (!isTronAddress(depositAddress)) {
    return res.status(400).json({ error: 'Endereço TRON inválido' });
  }

  const btcRate = await getCachedPrice();
  const feeBRL = Math.max(config.feeMinBrl, amountBRL * (config.feeBps / 10_000));
  const payoutBRL = amountBRL - feeBRL;
  if (payoutBRL <= 0) {
    return res.status(400).json({ error: 'Valor insuficiente após taxa' });
  }
  const btcAmount = payoutBRL / btcRate; // mantém nome legado, representa USDT líquido
  const id = uuidv4();

  const order = {
    id,
    status: 'aguardando_deposito',
    amountBRL,
    btcAmount,
    feeBRL,
    payoutBRL,
    address: depositAddress,
    asset: normalizedAsset,
    network: normalizedNetwork,
    rateLocked: btcRate,
    rateLockExpiresAt: new Date(Date.now() + config.rateLockSec * 1000),
    createdAt: new Date(),
    pixKey: 'chavepix@nexswap.com',
    qrCodeUrl: '/images/qrcode.png',
    pixCpf,
    pixPhone,
    derivationIndex
  };

  await createOrder(order);
  await addEvent(order.id, 'order.meta', {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    pixCpf,
    pixPhone
  });
  publish('order.created', order);

  res.json({
    orderId: id,
    btcAmount,
    rate: btcRate,
    status: order.status,
    feeBRL,
    payoutBRL,
    pixKey: order.pixKey,
    qrCodeUrl: order.qrCodeUrl,
    depositAddress,
    network: normalizedNetwork
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
  const secret = config.tronHmacSecret;
  if (!secret) return res.status(400).json({ error: 'TRON_HMAC_SECRET não configurado' });
  const raw = req.rawBody || Buffer.from('');
  const signature = req.headers['x-internal-hmac'];
  if (!isValidHmac(secret, raw, signature)) {
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  const DepositSchema = z.object({
    txHash: z.string().min(3),
    amount: z.number().positive()
  });
  const parsed = DepositSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payload inválido', details: parsed.error.issues });
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Ordem não encontrada' });

  const idemKey = req.headers['x-idempotency-key'];
  if (idemKey) {
    const exists = await hasEvent(order.id, 'idempotency', 'key', idemKey);
    if (exists) return res.status(200).json({ ok: true, duplicate: true });
    await addEvent(order.id, 'idempotency', { key: idemKey, endpoint: 'deposit' });
  }

  if (order.status !== 'aguardando_deposito') {
    return res.status(400).json({ error: `Status atual não permite depósito: ${order.status}` });
  }
  await updateOrderStatus(order.id, 'pago', { depositTx: parsed.data.txHash, depositAmount: parsed.data.amount });
  publish('onchain.detected', { orderId: order.id, txHash: parsed.data.txHash, amount: parsed.data.amount });
  publish('payout.requested', { orderId: order.id });
  res.json({ ok: true });
});

// Registrar payout PIX (stub)
app.post('/api/order/:id/payout', async (req, res) => {
  const secret = config.tronHmacSecret;
  if (!secret) return res.status(400).json({ error: 'TRON_HMAC_SECRET não configurado' });
  const raw = req.rawBody || Buffer.from('');
  const signature = req.headers['x-internal-hmac'];
  if (!isValidHmac(secret, raw, signature)) {
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  const PayoutSchema = z.object({
    providerId: z.string().min(1),
    status: z.enum(['concluída', 'erro']),
    error: z.string().optional()
  });
  const parsed = PayoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payload inválido', details: parsed.error.issues });
  const order = await getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Ordem não encontrada' });

  const idemKey = req.headers['x-idempotency-key'];
  if (idemKey) {
    const exists = await hasEvent(order.id, 'idempotency', 'key', idemKey);
    if (exists) return res.status(200).json({ ok: true, duplicate: true });
    await addEvent(order.id, 'idempotency', { key: idemKey, endpoint: 'payout' });
  }

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

// Webhook PIX (PagBank) com HMAC e idempotência básica
app.post('/api/pix/webhook', async (req, res) => {
  if (!config.webhookSecret) return res.status(400).json({ error: 'WEBHOOK_SECRET não configurado' });
  const signature = req.headers['x-pagbank-signature'];
  const raw = req.rawBody || Buffer.from('');
  const hmac = crypto.createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
  if (!signature || signature !== hmac) return res.status(401).json({ error: 'Assinatura inválida' });
  let payload;
  try { payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'JSON inválido' }); }
  const { orderId, status, providerId, error } = payload || {};
  if (!orderId || !status || !providerId) return res.status(400).json({ error: 'Campos obrigatórios ausentes' });

  const duplicated = await hasEvent(orderId, 'webhook.provider', 'providerId', providerId);
  if (duplicated) return res.status(200).json({ ok: true, duplicate: true });

  const statusNorm = status.toLowerCase();
  try {
    if (statusNorm.startsWith('concl')) {
      await updateOrderStatus(orderId, 'concluída', { txHash: providerId || 'pix-webhook' });
    } else if (statusNorm === 'erro' || statusNorm === 'error') {
      await updateOrderStatus(orderId, 'erro', { error: error || 'payout erro' });
    } else {
      return res.status(400).json({ error: 'Status desconhecido' });
    }
    await addEvent(orderId, 'webhook.provider', { providerId, status: statusNorm, raw: payload });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao atualizar ordem', details: err.message });
  }
});

// Webhook PIX (PagBank) - BUY
app.post('/api/pix/webhook/buy', async (req, res) => {
  if (!config.webhookSecret) return res.status(400).json({ error: 'WEBHOOK_SECRET não configurado' });
  const signature = req.headers['x-pagbank-signature'];
  const raw = req.rawBody || Buffer.from('');
  const hmac = crypto.createHmac('sha256', config.webhookSecret).update(raw).digest('hex');
  if (!signature || signature !== hmac) return res.status(401).json({ error: 'Assinatura inválida' });
  let payload;
  try { payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'JSON inválido' }); }
  const { buyId, status, providerId, error } = payload || {};
  if (!buyId || !status) return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
  const statusNorm = status.toLowerCase();
  try {
    if (statusNorm.startsWith('concl')) {
      await updateBuyOrderStatus(buyId, 'pago_pix', { txHashOut: providerId || 'pix-webhook' });
      publish('buy.paid', { buyOrderId: buyId, providerId });
    } else if (statusNorm === 'erro' || statusNorm === 'error') {
      await updateBuyOrderStatus(buyId, 'erro', { error: error || 'pix erro' });
    } else {
      return res.status(400).json({ error: 'Status desconhecido' });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Falha ao atualizar buy', details: err.message });
  }
});

// Endpoint interno para registrar sweep (stub) - protegido por HMAC
app.post('/internal/sweep', (req, res) => {
  const secret = config.tronHmacSecret;
  if (!secret) return res.status(400).json({ error: 'TRON_HMAC_SECRET não configurado' });
  const signature = req.headers['x-internal-hmac'];
  const raw = req.rawBody || Buffer.from('');
  const hmac = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (signature !== hmac) return res.status(401).json({ error: 'Assinatura inválida' });
  const schema = z.object({
    childIndex: z.number().int().nonnegative(),
    toAddr: z.string().min(10),
    amount: z.number().positive(),
    network: z.string().default('TRON')
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Payload inválido', details: parsed.error.issues });
  const fromAddr = deriveTronAddress(parsed.data.childIndex);
  createSweep({
    childIndex: parsed.data.childIndex,
    fromAddr,
    toAddr: parsed.data.toAddr,
    amount: parsed.data.amount
  })
    .then(sweep => res.json({ ok: true, sweepId: sweep.id }))
    .catch(err => res.status(500).json({ error: 'Erro ao criar sweep', details: err.message }));
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
    await tronWeb.trx.getCurrentBlock();
    res.json({ ok: true, db: true, tron: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, tron: false, error: e.message });
  }
});
