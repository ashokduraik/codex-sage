import 'dotenv/config';
import { buildApp } from './http/app.js';
import { IDENTITY_MODELS, runBootstrapSeed } from './modules/identity/index.js';
import { loadConfig } from './platform/config.js';
import { syncSchemaIndexes } from './platform/data/index.js';
import { connectMongo, disconnectMongo } from './platform/mongo.js';
import { registerProcessHandlers } from './platform/processHandlers.js';
import {
  attachShutdownSignals,
  registerShutdownHook,
} from './platform/shutdown.js';

/**
 * Application entry point (API process).
 *
 * Startup sequence:
 *   1. Register process-level rejection/exception safety nets.
 *   2. Load validated config from the environment.
 *   3. Connect to MongoDB (fail fast on first connect).
 *   4. Sync schema indexes in non-production.
 *   5. Run the idempotent bootstrap seed.
 *   6. Build the Fastify app, register shutdown hooks, and listen.
 */
async function start() {
  registerProcessHandlers({
    logError: (message, context) => {
      console.error(JSON.stringify({ level: 'error', msg: message, ...context }));
    },
  });
  const config = loadConfig();
  const shutdownLog = {
    info: (obj, msg) => {
      console.info(JSON.stringify({ level: 'info', msg, ...obj }));
    },
    warn: (obj, msg) => {
      console.warn(JSON.stringify({ level: 'warn', msg, ...obj }));
    },
    error: (obj, msg) => {
      console.error(JSON.stringify({ level: 'error', msg, ...obj }));
    },
    debug: (obj, msg) => {
      if (config.logging.level === 'debug') {
        console.debug(JSON.stringify({ level: 'debug', msg, ...obj }));
      }
    },
  };
  try {
    await connectMongo(config, shutdownLog);
  } catch {
    process.exit(1);
  }

  if (!config.env.isProduction) {
    try {
      await syncSchemaIndexes([...IDENTITY_MODELS]);
    } catch (err) {
      shutdownLog.error(
        { errName: err instanceof Error ? err.name : 'Error' },
        'schema index sync failed',
      );
      process.exit(1);
    }
  }

  try {
    await runBootstrapSeed(shutdownLog);
  } catch {
    process.exit(1);
  }

  const app = buildApp(config);
  registerShutdownHook('close-http', async () => {
    await app.close();
  });
  registerShutdownHook('disconnect-mongo', async () => {
    await disconnectMongo();
  });
  attachShutdownSignals({ log: shutdownLog });
  await app.listen({ host: config.server.host, port: config.server.port });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
