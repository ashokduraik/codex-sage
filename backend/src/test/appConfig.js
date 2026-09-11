/** Shared AppConfig for HTTP route and platform unit tests. */
export const TEST_JWT_ACCESS_TOKEN_SECRET =
  'test-jwt-access-token-secret-at-least-32-chars';

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
};
