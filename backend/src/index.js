import 'dotenv/config';
import { buildApp } from './http/app.js';
import { AUDIT_MODELS } from './modules/access/index.js';
import { AUTH_MODELS } from './modules/access/index.js';
import { assertRolePermissionsInCatalog } from './modules/access/index.js';
import { IDENTITY_MODELS, runBootstrapSeed } from './modules/masters/index.js';
import { PROJECT_MODELS } from './modules/masters/index.js';
import { JOB_MODELS, NOTIFICATION_MODELS, PROJECT_ACTIVITY_MODELS } from './modules/masters/index.js';
import { SOURCE_MODELS } from './modules/knowledge/index.js';
import { DOCUMENT_MODELS } from './modules/knowledge/index.js';
import { KNOWLEDGE_MODELS } from './modules/knowledge/index.js';
import { REPOSITORY_MODELS } from './modules/knowledge/index.js';
import { CONVERSATION_MODELS, assertLlmAvailable } from './modules/conversation/index.js';
import { ProjectJobLock } from './models/projectJobLock.model.js';
import { loadConfig } from './platform/config.js';
import { syncSchemaIndexes } from './platform/data/index.js';
import { IDEMPOTENCY_MODELS } from './platform/idempotency/index.js';
import { createAppLogger } from './platform/logger.js';
import { connectMongo, disconnectMongo } from './platform/mongo.js';
import { attachShutdownSignals, registerProcessHandlers, registerShutdownHook } from './platform/shutdown.js';

/**
 * Application entry point (API process).
 *
 * Startup sequence:
 *   1. Register process-level rejection/exception safety nets.
 *   2. Load validated config from the environment.
 *   3. Connect to MongoDB (fail fast on first connect).
 *   4. Probe the OpenAI-compatible LLM and attach artifact id (fail fast).
 *   5. Sync schema indexes in non-production.
 *   6. Run the idempotent bootstrap seed.
 *   7. Assert stored role permissions exist in the catalog.
 *   8. Build the Fastify app, register shutdown hooks, and listen.
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

  try {
    const runtime = await assertLlmAvailable(config.llm, shutdownLog);
    config.llm.artifactId = runtime.artifactId;
  } catch {
    process.exit(1);
  }

  if (!config.env.isProduction) {
    try {
      await syncSchemaIndexes([
        ...IDENTITY_MODELS,
        ...AUTH_MODELS,
        ...AUDIT_MODELS,
        ...IDEMPOTENCY_MODELS,
        ...PROJECT_MODELS,
        ...JOB_MODELS,
        ...NOTIFICATION_MODELS,
        ...PROJECT_ACTIVITY_MODELS,
        ...SOURCE_MODELS,
        ...DOCUMENT_MODELS,
        ...KNOWLEDGE_MODELS,
        ...REPOSITORY_MODELS,
        ...CONVERSATION_MODELS,
        ProjectJobLock,
      ]);
    } catch (err) {
      shutdownLog.error({ errName: err instanceof Error ? err.name : 'Error' }, 'schema index sync failed');
      process.exit(1);
    }
  }

  try {
    await runBootstrapSeed(shutdownLog);
  } catch {
    process.exit(1);
  }

  try {
    await assertRolePermissionsInCatalog();
  } catch (err) {
    shutdownLog.error(
      {
        errName: err instanceof Error ? err.name : 'Error',
        errMessage: err instanceof Error ? err.message : String(err),
      },
      'role permission catalog audit failed',
    );
    process.exit(1);
  }

  const loggerInstance = await createAppLogger(config);
  const app = buildApp(config, { loggerInstance });
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
