import 'dotenv/config';
import { buildApp } from './http/app';
import { loadConfig } from './platform/config';
import { registerProcessHandlers } from './platform/processHandlers';

/**
 * Application entry point.
 *
 * Startup sequence:
 *   1. Register process-level rejection/exception safety nets.
 *   2. Load validated config from the environment.
 *   3. Build the Fastify app and start listening.
 */
async function start(): Promise<void> {
  registerProcessHandlers({
    logError: (message, context) => {
      console.error(JSON.stringify({ level: 'error', msg: message, ...context }));
    },
  });

  const config = loadConfig();
  const app = buildApp(config);

  await app.listen({ host: config.host, port: config.port });
}

start().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
