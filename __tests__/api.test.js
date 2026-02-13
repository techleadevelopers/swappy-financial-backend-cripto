import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../db.js', () => ({
  createOrder: vi.fn(async () => {}),
  getOrder: vi.fn(async (id) => id === 'known' ? { id: 'known', status: 'aguardando_deposito' } : null),
  updateOrderStatus: vi.fn(async () => {})
}));
vi.mock('../workers/priceWorker.js', () => ({
  getCachedPrice: vi.fn(async () => 5_000), // 1 USDT = 5k BRL fake
  startPriceWorker: vi.fn()
}));
vi.mock('../queue.js', () => ({
  publish: vi.fn()
}));

import { app } from '../app.js';

describe('API basic', () => {
  it('GET /healthz', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/order validation fails without amount', async () => {
    const res = await request(app).post('/api/order').send({ address: '0xabc' });
    expect(res.status).toBe(400);
  });

  it('POST /api/order creates order', async () => {
    const res = await request(app).post('/api/order').send({
      amountBRL: 100,
      address: '0x1111111111111111111111111111111111111111'
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('aguardando_deposito');
  });

  it('GET /api/order/:id not found', async () => {
    const res = await request(app).get('/api/order/unknown');
    expect(res.status).toBe(404);
  });
});
