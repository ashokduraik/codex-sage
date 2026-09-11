import type { AppConfig } from '../platform/config';

/** Shared AppConfig for HTTP route and platform unit tests. */
export const TEST_APP_CONFIG: AppConfig = {
  host: '127.0.0.1',
  port: 0,
  nodeEnv: 'test',
  logger: false,
  appRunningPlatform: 'standalone',
  logLevel: 'info',
  noConsoleLog: false,
};
