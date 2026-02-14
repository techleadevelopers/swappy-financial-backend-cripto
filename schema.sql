-- Orders principais
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  status VARCHAR(32) NOT NULL,
  amount_brl NUMERIC(18,2) NOT NULL,
  btc_amount NUMERIC(28,8) NOT NULL,
  address TEXT NOT NULL,
  asset VARCHAR(16) NOT NULL DEFAULT 'USDT',
  network VARCHAR(32) NOT NULL DEFAULT 'ERC20',
  rate_locked NUMERIC(28,8) NOT NULL,
  rate_lock_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  tx_hash TEXT,
  error TEXT,
  deposit_tx TEXT,
  deposit_amount NUMERIC(28,8),
  pix_cpf TEXT,
  pix_phone TEXT,
  derivation_index INT
);

-- Eventos para auditoria e reconciliação
CREATE TABLE IF NOT EXISTS order_events (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  type VARCHAR(32) NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Payouts PIX
CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  pix_cpf TEXT,
  pix_key TEXT,
  status VARCHAR(32) NOT NULL,
  provider_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS onchain_cursor (
  id SERIAL PRIMARY KEY,
  network VARCHAR(32) NOT NULL,
  last_block BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT onchain_cursor_network_unique UNIQUE(network)
);

CREATE TABLE IF NOT EXISTS sweeps (
  id UUID PRIMARY KEY,
  child_index INT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  amount NUMERIC(28,8) NOT NULL,
  tx_hash TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key TEXT,
  amount_trx_fee NUMERIC(28,8),
  order_id UUID
);

-- Compatibilidade: adiciona coluna se jÃ¡ existir tabela anterior
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='derivation_index') THEN
    ALTER TABLE orders ADD COLUMN derivation_index INT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sweeps' AND column_name='idempotency_key') THEN
    ALTER TABLE sweeps ADD COLUMN idempotency_key TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sweeps' AND column_name='amount_trx_fee') THEN
    ALTER TABLE sweeps ADD COLUMN amount_trx_fee NUMERIC(28,8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='sweeps' AND column_name='order_id') THEN
    ALTER TABLE sweeps ADD COLUMN order_id UUID;
  END IF;
END$$;
