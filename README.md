# Swappy Backend — Off-Ramp USDT → PIX (TRON)

## Visão Geral
Backend Node/Express para off-ramp: o usuário envia USDT (TRC20) para um endereço derivado via XPUB; detectamos on-chain e liquidamos via PIX (PagBank). Chaves privadas não ficam no app; apenas XPUB para derivar endereços. Payout é via PagBank; sweeps e assinaturas on-chain devem rodar em serviço isolado/HSM.

## Fluxo de Negócio
1) Criação de ordem (`POST /api/order`)
   - `amountBRL`, dados PIX (`pixCpf`, `pixPhone`); `network` default TRON, `asset` default USDT.
   - Se não enviar endereço, derivamos um TRON via `TRON_XPUB`; se enviar, validamos.
   - Valida limites min/max, trava cotação USDT/BRL com TTL, status `aguardando_deposito`.
2) Depósito detectado (TRC20)
   - Listener TRON consulta eventos `Transfer` do contrato USDT, com cursor/paginação e confirmações.
   - Ao encontrar depósito ≥ esperado: status `pago`, grava `deposit_tx`/`deposit_amount`, publica `onchain.detected` e `payout.requested`.
3) Payout PIX (PagBank)
   - `payoutWorker` chama PagBank (ou simula se token ausente); webhook `/api/pix/webhook` com HMAC fecha `concluída` ou `erro`.
4) Status para o cliente
   - `GET /api/order/:id` ou SSE `GET /api/order/:id/stream`.

## Endpoints
- `GET /api/price` — preço USDT/BRL (CoinGecko) com cache.
- `POST /api/order` — cria ordem, gera/valida endereço TRON, status `aguardando_deposito`.
- `GET /api/order/:id` — consulta ordem.
- `GET /api/order/:id/stream` — SSE de status.
- `POST /api/order/:id/deposit` — permite registrar depósito detectado (útil para testes).
- `POST /api/order/:id/payout` — marca payout PIX (fallback/manual).
- `POST /api/pix/webhook` — webhook PagBank com HMAC (`PIX_WEBHOOK_SECRET`).
- `POST /internal/sweep` — cria sweep pending (HMAC `TRON_HMAC_SECRET`) para varrer endereços filhos.
- `GET /healthz` / `GET /readyz` — readiness checa DB e nó TRON.

## Workers
- `onchainWorker`: listener TRON TRC20 com cursor; detecta depósito e dispara payout.
- `payoutWorker`: integra PagBank (simula se token ausente).
- `priceWorker`: cacheia preço USDT/BRL.
- `sweepWorker`: stub que marca sweeps como enviados; em produção deve chamar signer/broadcaster.

## Persistência
- Postgres: `orders`, `order_events`, `payouts`, `onchain_cursor`, `sweeps` (schema em `server/schema.sql`).
- Event bus em memória (`queue.js`) para orquestrar workers.

## Configuração (.env.example)
Principais vars:
```
DATABASE_URL=postgres://user:pass@host:5432/db
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3000
WEBHOOK_SECRET=...
ORDER_MIN_BRL / ORDER_MAX_BRL
RATE_LIMIT_WINDOW_MS / RATE_LIMIT_MAX
ORDER_RATE_LIMIT_WINDOW_MS / ORDER_RATE_LIMIT_MAX
# Tron / USDT TRC20
TRON_FULLNODE_URL=...
TRON_SOLIDITY_URL=...
TRON_USDT_CONTRACT=...
TRON_USDT_DECIMALS=6
TRON_CONFIRMATIONS=20
TRON_XPUB=seu-xpub
TRON_HMAC_SECRET=...
# PagBank
PAGSEGURO_API_TOKEN=...
PAGSEGURO_API_BASE_URL=https://api.pagseguro.com
PIX_WEBHOOK_SECRET=...
```

## Roadmap Prod (essencial)
- Assinador/broadcaster isolado (HSM/KMS/MPC) para sweeps TRON.
- Listener TRON com checkpoint persistente (cursor) e paginação robusta.
- PagBank oficial + webhook assinado/idempotência.
- Fila gerenciada (SQS/PubSub/Kafka) e Redis para cache/locks.
- Auth HMAC/JWT entre serviços internos; métricas/trace; limites de spend no signer.

## Como rodar local
```bash
npm install
psql "$DATABASE_URL" -f schema.sql
node server.js
```
