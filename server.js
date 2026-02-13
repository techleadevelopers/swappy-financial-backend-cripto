import { app } from './app.js';
import { initSchema } from './db.js';
import { startPriceWorker } from './workers/priceWorker.js';
import { startOnchainWorker } from './workers/onchainWorker.js';
import { startPayoutWorker } from './workers/payoutWorker.js';
import { logger } from './logger.js';

(async () => {
  await initSchema();
  startPriceWorker();
  startOnchainWorker();
  startPayoutWorker();
  const port = process.env.PORT || 3000;
  app.listen(port, () => logger.info({ port }, 'Server started'));
})();
