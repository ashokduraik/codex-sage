/**
 * Worker process entrypoint — loads env and boots {@link startWorker}.
 */
import 'dotenv/config';
import { startWorker } from './startWorker.js';

startWorker().catch((err) => {
  console.error(err);
  process.exit(1);
});
