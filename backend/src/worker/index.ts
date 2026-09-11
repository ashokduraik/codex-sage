/**
 * Worker process entrypoint — loads env and boots {@link startWorker}.
 */

import 'dotenv/config';
import { startWorker } from './startWorker';

startWorker().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
