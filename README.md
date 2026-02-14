<div align="center">
<h2><img src="https://res.cloudinary.com/limpeja/image/upload/v1770993671/swap_1_mvctri.png" alt="swap Logo" width="480"> Deliver instans Buy and Sell payment Pix USDT → PIX (TRON)</h2>
</div>

## Visão Geral
Backend Node/Express para off-ramp: o usuário envia USDT (TRC20) para um endereço derivado via XPUB; detectamos on-chain e liquidamos via PIX (PagBank). Chaves privadas não ficam no app; apenas XPUB para derivar endereços. Payout é via PagBank; sweeps e assinaturas on-chain devem rodar em serviço isolado/HSM.

## Fluxo de Negócio (atual)
1) Criação de ordem (`POST /api/order`)
   - Obrigatório: `amountBRL` e um de `pixCpf`/`pixPhone`; rede/ativo travados em TRON/USDT.
   - Limites por chave PIX na criação: `PIX_MAX_ORDERS_PER_24H` (contagem) e `PIX_MAX_BRL_PER_24H` (valor). Estouro retorna 429.
   - Endereço TRON sempre derivado via `TRON_XPUB` (ou validado se enviado). TTL via `rateLockSec` → `rate_lock_expires_at`.
   - Evento `order.meta` guarda IP e User-Agent para auditoria.

2) Depósito detectado (TRC20)
   - Poller com cursor/paginação em eventos `Transfer` do `TRON_USDT_CONTRACT`.
   - Confirmações: espera `TRON_CONFIRMATIONS`.
   - Valor: precisa estar dentro de `TRON_DEPOSIT_TOLERANCE_PCT` (padrão 2%) do esperado; fora da faixa → `aguardando_validacao` (manual).
   - TTL: se expirada, marca `expirada` e não paga.
   - Idempotência por `txHash`; endereços desconhecidos/expirados ignorados (payout só para a ordem mapeada).
   - Delay inteligente: primeira ordem da chave PIX espera `ORDER_HOLD_SEC_FOR_NEW_DEST` (default 180s) antes de publicar payout; demais são imediatas.

3) Payout PIX (PagBank)
   - `payoutWorker` chama PagBank (ou simula se token ausente) e marca `concluída`/`erro`. Destino PIX é o informado na criação (não muda depois).

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
- `onchainWorker`: listener TRON TRC20 com cursor; aplica TTL da ordem, tolerância de valor, confirmações, idempotência por txHash e delay inteligente na primeira ordem da chave PIX.
- `payoutWorker`: integra PagBank (simula se token ausente).
- `priceWorker`: cacheia preço USDT/BRL.
- `sweepWorker`: faz sweeps reais via signer (HMAC); fallback stub só se `ENABLE_SWEEP_WORKER=false` e `ENABLE_SWEEP_STUB=true`.

## Persistência
- Postgres: `orders`, `order_events`, `payouts`, `onchain_cursor`, `sweeps` (schema em `server/schema.sql`).
- Event bus em memória (`queue.js`) para orquestrar workers.
- `sweeps` inclui `idempotency_key` e `amount_trx_fee`; migração condicional no schema.

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
PIX_MAX_ORDERS_PER_24H=5
PIX_MAX_BRL_PER_24H=20000
ORDER_HOLD_SEC_FOR_NEW_DEST=180
TRON_DEPOSIT_TOLERANCE_PCT=0.02
# Tesouraria / signer / sweep
TREASURY_HOT=TRXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TREASURY_COLD=TRXXXXXXXXXXXXXXXXXXXXXXXXXXXX
SIGNER_URL=https://signer.internal/sign/transfer
SIGNER_HMAC_SECRET=change-me
ENABLE_SWEEP_WORKER=false
ENABLE_SWEEP_STUB=true
SWEEP_BATCH_USDT_MIN=0
SWEEP_BATCH_USDT_MAX=1000000
SWEEP_FREQUENCY_MS=30000
TRON_GAS_RESERVE_TRX=5
# PagBank
PAGSEGURO_API_TOKEN=...
PAGSEGURO_API_BASE_URL=https://api.pagseguro.com
PIX_WEBHOOK_SECRET=...
```

## Roadmap Prod (essencial)
- Assinador/broadcaster isolado (HSM/KMS/MPC) para sweeps TRON, com allowlist de destino (treasury hot/cold) e HMAC/mTLS.
- Listener TRON já usa cursor; manter paginação/monitoramento.
- PagBank oficial + webhook assinado/idempotência (já presente).
- Fila gerenciada (SQS/PubSub/Kafka) e Redis para cache/locks.
- Auth HMAC/JWT entre serviços internos; métricas/trace; limites de spend no signer.

## Como rodar local
```bash
npm install
psql "$DATABASE_URL" -f schema.sql
node server.js
```
