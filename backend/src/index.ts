import 'dotenv/config';
import { buildApp } from './http/app';
import { loadConfig } from './platform/config';
import { connectMongo, disconnectMongo } from './platform/mongo';
import { registerProcessHandlers } from './platform/processHandlers';
import {
  attachShutdownSignals,
  registerShutdownHook,
} from './platform/shutdown';

/**
 * Application entry point (API process).
 *
 * Startup sequence:
 *   1. Register process-level rejection/exception safety nets.
 *   2. Load validated config from the environment.
 *   3. Connect to MongoDB (fail fast on first connect).
 *   4. Build the Fastify app, register shutdown hooks, and listen.
 */
async function start(): Promise<void> {
  registerProcessHandlers({
    logError: (message, context) => {
      console.error(JSON.stringify({ level: 'error', msg: message, ...context }));
    },
  });

  const config = loadConfig();

  const shutdownLog = {
    info: (obj: Record<string, unknown>, msg: string) => {
      console.info(JSON.stringify({ level: 'info', msg, ...obj }));
    },
    warn: (obj: Record<string, unknown>, msg: string) => {
      console.warn(JSON.stringify({ level: 'warn', msg, ...obj }));
    },
    error: (obj: Record<string, unknown>, msg: string) => {
      console.error(JSON.stringify({ level: 'error', msg, ...obj }));
    },
  };

  try {
    await connectMongo(config);
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

start().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
