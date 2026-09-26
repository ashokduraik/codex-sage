/** Shared AppConfig for HTTP route and platform unit tests. */
import os from 'node:os';
import path from 'node:path';

export const TEST_JWT_ACCESS_TOKEN_SECRET = 'test-jwt-access-token-secret-at-least-32-chars';

/** Absolute workspace root for tests (override per suite with a unique temp dir when needed). */
export const TEST_WORKSPACE_ROOT = path.join(os.tmpdir(), 'codex-sage-workspace-test');

export const TEST_APP_CONFIG = {
  env: {
    nodeEnv: 'test',
    isProduction: false,
    isTest: true,
    appRunningPlatform: 'standalone',
  },
  server: {
    host: '127.0.0.1',
    port: 0,
  },
  logging: {
    level: 'info',
    logger: false,
    noConsoleLog: false,
  },
  mongo: {
    uri: 'mongodb://127.0.0.1:27017/codex_sage_test?replicaSet=rs0',
  },
  auth: {
    jwtAccessTokenSecret: TEST_JWT_ACCESS_TOKEN_SECRET,
  },
  workspace: {
    root: TEST_WORKSPACE_ROOT,
  },
  repositories: {
    encryptionKey: Buffer.alloc(32, 7),
    keyId: 'k1',
    allowPrivateHosts: false,
  },
  llm: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    modelId: 'qwen3.8:latest',
    contextCapacity: 131072,
    apiKey: null,
  },
};
