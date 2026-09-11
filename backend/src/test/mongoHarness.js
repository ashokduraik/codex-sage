/**
 * Integration-test Mongo harness (D16): same replica set, database `codex_sage_test` only.
 */
import mongoose from 'mongoose';
import { loadConfig } from '../platform/config.js';
import {
  MONGODB_MAX_POOL_SIZE,
  MONGODB_MIN_POOL_SIZE,
  MONGODB_SERVER_SELECTION_TIMEOUT_MS,
  MONGODB_SOCKET_TIMEOUT_MS,
} from '../platform/mongo.js';
import { syncSchemaIndexes } from '../platform/data/syncIndexes.js';

/** Database name substituted into MONGODB_URI for integration tests. */
export const TEST_DATABASE_NAME = 'codex_sage_test';

/**
 * Rewrites the URI path so the database name is exactly {@link TEST_DATABASE_NAME}.
 * @param {string} uri Source MongoDB connection string.
 * @returns {string} URI pointing at the test database.
 * @throws {Error} When the rewritten database name is not the test database.
 */
export function rewriteMongoUriForTests(uri) {
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new Error('MONGODB_URI is required for the integration harness');
  }
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('MONGODB_URI is not a valid URL');
  }
  parsed.pathname = `/${TEST_DATABASE_NAME}`;
  const database = parsed.pathname.replace(/^\//, '');
  if (database !== TEST_DATABASE_NAME) {
    throw new Error(
      `Integration harness refuses database "${database}"; expected "${TEST_DATABASE_NAME}"`,
    );
  }
  return parsed.toString();
}

/**
 * Creates connect / cleanup helpers for a Vitest file using real Mongo.
 * @param {{
 *   models?: import('mongoose').Model[],
 *   uri?: string,
 * }} [options] Models to index-sync and clear; optional explicit URI (else loadConfig).
 * @returns {{
 *   beforeAll: () => Promise<void>,
 *   afterEach: () => Promise<void>,
 *   afterAll: () => Promise<void>,
 *   getUri: () => string,
 * }}
 */
export function createMongoHarness(options = {}) {
  const models = options.models ?? [];
  let testUri = '';

  return {
    /**
     * Resolves the URI used for this harness (after beforeAll).
     * @returns {string}
     */
    getUri() {
      return testUri;
    },

    /**
     * Connects to codex_sage_test and syncs indexes for registered models.
     * @returns {Promise<void>}
     */
    async beforeAll() {
      const sourceUri = options.uri ?? loadConfig().mongo.uri;
      testUri = rewriteMongoUriForTests(sourceUri);
      mongoose.set('bufferCommands', false);
      mongoose.set('autoIndex', false);
      await mongoose.connect(testUri, {
        maxPoolSize: MONGODB_MAX_POOL_SIZE,
        minPoolSize: MONGODB_MIN_POOL_SIZE,
        serverSelectionTimeoutMS: MONGODB_SERVER_SELECTION_TIMEOUT_MS,
        socketTimeoutMS: MONGODB_SOCKET_TIMEOUT_MS,
      });
      if (models.length > 0) {
        await syncSchemaIndexes(models);
      }
    },

    /**
     * Deletes all documents from registered model collections (isolation).
     * Uses the native collection API so append-only model middleware cannot block cleanup.
     * @returns {Promise<void>}
     */
    async afterEach() {
      for (const model of models) {
        await model.collection.deleteMany({});
      }
    },

    /**
     * Disconnects. Collection cleanup is handled by afterEach deleteMany so parallel
     * Vitest files sharing codex_sage_test do not race on dropDatabase.
     * @returns {Promise<void>}
     */
    async afterAll() {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    },
  };
}
