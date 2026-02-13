# Swappy Backend (Off-Ramp USDT → PIX)

## Visão Geral
Backend Node/Express preparado para off-ramp: o usuário envia cripto (USDT) para a carteira da plataforma, o sistema detecta o depósito on-chain e liquida em PIX. Atualmente em modo stub (sem integrações reais), com arquitetura pronta para evoluir com filas gerenciadas, listener on-chain real e provedor PIX.

## Fluxo de Negócio (pretendido)
1) Criação de ordem (`POST /api/order`):
   - Recebe `amountBRL`, `address`, opcional `asset`/`network` (default USDT/ERC20) e dados PIX (`pixCpf`, `pixPhone`).
   - Valida endereço (BTC/ETH), limites min/max, trava cotação USDT/BRL com TTL.
   - Persiste em Postgres com status `aguardando_deposito`.
   - Publica evento `order.created`.
2) Depósito detectado:
   - Listener on-chain (stub) publica `onchain.detected` e atualiza status para `pago` (via `/api/order/:id/deposit`).
3) Payout PIX:
   - Worker payout (stub) consome `payout.requested`, marca `concluída` (via `/api/order/:id/payout`).
4) Status:
   - `/api/order/:id` para polling.
   - `/api/order/:id/stream` (SSE) envia mudanças de status em tempo quase real.

## Endpoints
- `GET /api/price` — preço USDT/BRL (CoinGecko) com cache.
- `POST /api/order` — cria ordem, valida limites e endereço, status `aguardando_deposito`.
- `GET /api/order/:id` — consulta ordem.
- `GET /api/order/:id/stream` — SSE de status.
- `POST /api/order/:id/deposit` — marca depósito detectado (stub).
- `POST /api/order/:id/payout` — marca payout PIX (stub).
- `POST /api/pix/webhook` — stub de webhook PagBank com verificação HMAC.
- `GET /healthz` / `GET /readyz` — health/readiness simples.

## Segurança e Endurecimento
- Helmet, rate limit global e por rota de criação, CORS restrito.
- Validação Zod de payloads e schema de ambiente.
- Logger estruturado (Pino).
- WEBHOOK_SECRET para HMAC simples; webhook PagBank valida assinatura.

## Persistência e Eventos
- Postgres: tabelas `orders`, `order_events`, `payouts` (schema em `server/schema.sql`).
- Event bus em memória (`queue.js`) com workers stubs:
  - `onchainWorker`: simula depósito após delay, publica `payout.requested`.
  - `payoutWorker`: simula payout, marca `concluída`.
  - `priceWorker`: cacheia preço USDT/BRL.

## Configuração (env)
Principais vars (ver `.env.example`):
```
DATABASE_URL=postgres://user:pass@host:5432/db
ALLOWED_ORIGINS=http://localhost:5173
WEBHOOK_SECRET=...
ORDER_MIN_BRL / ORDER_MAX_BRL
RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX
ORDER_RATE_LIMIT_WINDOW_MS / ORDER_RATE_LIMIT_MAX
PAGSEGURO_API_TOKEN / PIX_WEBHOOK_SECRET (preencher apenas em ambiente seguro)
```

## Roadmap (para produção)
- Listener on-chain real (USDT nas redes suportadas) + confirmações.
- Integração PIX PagBank oficial (sandbox → prod) com webhooks assinados/idempotência.
- Fila gerenciada (SQS/PubSub/Kafka) e Redis para cache/locks.
- Auth HMAC/JWT robusto em webhooks internos; health/readiness completos; métricas/trace.
- SSE/WebSocket com backplane real (Redis/pubsub).

## Como rodar local
```bash
npm install
psql "$DATABASE_URL" -f server/schema.sql
node server/server.js
```

