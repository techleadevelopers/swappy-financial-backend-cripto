import axios from 'axios';
import { publish } from '../queue.js';

// Cache simples em memória com TTL curto
let cache = { price: null, expiresAt: 0 };

export async function getCachedPrice() {
  const now = Date.now();
  if (cache.price && cache.expiresAt > now) return cache.price;
  const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=brl');
  cache = {
    price: data.tether.brl,
    expiresAt: now + 60_000
  };
  publish('price.updated', cache.price);
  return cache.price;
}

export function startPriceWorker() {
  // noop placeholder; poderia agendar atualizações periódicas
}
