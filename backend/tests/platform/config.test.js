import { describe, it, expect } from 'vitest';
import { loadConfig, parseAppRunningPlatform, parseLogLevel, parsePort, resolveRepositoryCrypto } from '../../src/platform/config.js';
/** Minimal valid env for loadConfig tests. */
const VALID_ENV = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/codex_sage?replicaSet=rs0',
  JWT_ACCESS_TOKEN_SECRET: 'test-jwt-access-token-secret-at-least-32-chars',
  WORKSPACE_ROOT: '/tmp/codex-sage-workspace-test-config',
  REPO_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};
describe('loadConfig', () => {
  it('uses defaults when optional env variables are absent', () => {
    const cfg = loadConfig({ ...VALID_ENV });
    expect(cfg.server.host).toBe('0.0.0.0');
    expect(cfg.server.port).toBe(3000);
    expect(cfg.env.nodeEnv).toBe('development');
    expect(cfg.env.isProduction).toBe(false);
    expect(cfg.env.isTest).toBe(false);
    expect(cfg.logging.logger).toBe(true);
    expect(cfg.env.appRunningPlatform).toBe('standalone');
    expect(cfg.logging.level).toBe('info');
    expect(cfg.logging.noConsoleLog).toBe(false);
    expect(cfg.mongo.uri).toBe(VALID_ENV.MONGODB_URI);
    expect(cfg.auth.jwtAccessTokenSecret).toBe(VALID_ENV.JWT_ACCESS_TOKEN_SECRET);
    expect(cfg.workspace.root).toBe(VALID_ENV.WORKSPACE_ROOT);
    expect(cfg.repositories.keyId).toBe('k1');
    expect(cfg.repositories.allowPrivateHosts).toBe(false);
    expect(Buffer.isBuffer(cfg.repositories.encryptionKey)).toBe(true);
    expect(cfg.repositories.encryptionKey.length).toBe(32);
  });
  it('reads overrides from env', () => {
    const cfg = loadConfig({
      ...VALID_ENV,
      API_HOST: '127.0.0.1',
      API_PORT: '8080',
      NODE_ENV: 'production',
      APP_RUNNING_PLATFORM: 'container',
      LOG_LEVEL: 'warning',
      NO_CONSOLE_LOG: 'true',
    });
    expect(cfg.server.host).toBe('127.0.0.1');
    expect(cfg.server.port).toBe(8080);
    expect(cfg.env.nodeEnv).toBe('production');
    expect(cfg.env.isProduction).toBe(true);
    expect(cfg.logging.logger).toBe(true);
    expect(cfg.env.appRunningPlatform).toBe('container');
    expect(cfg.logging.level).toBe('warning');
    expect(cfg.logging.noConsoleLog).toBe(true);
    expect(cfg.auth.jwtAccessTokenSecret).toBe(VALID_ENV.JWT_ACCESS_TOKEN_SECRET);
  });
  it('disables the logger and sets isTest under NODE_ENV=test', () => {
    const cfg = loadConfig({ ...VALID_ENV, NODE_ENV: 'test' });
    expect(cfg.logging.logger).toBe(false);
    expect(cfg.env.nodeEnv).toBe('test');
    expect(cfg.env.isTest).toBe(true);
  });
  it('defaults WORKSPACE_ROOT under NODE_ENV=test when unset', () => {
    const { WORKSPACE_ROOT: _omit, ...withoutRoot } = VALID_ENV;
    const cfg = loadConfig({ ...withoutRoot, NODE_ENV: 'test' });
    expect(cfg.workspace.root).toMatch(/codex-sage-workspace-test$/);
  });
  it('throws when WORKSPACE_ROOT is missing outside test', () => {
    const { WORKSPACE_ROOT: _omit, ...withoutRoot } = VALID_ENV;
    expect(() => loadConfig({ ...withoutRoot, NODE_ENV: 'development' })).toThrow(/WORKSPACE_ROOT/);
  });
  it('throws when WORKSPACE_ROOT is not absolute', () => {
    expect(() => loadConfig({ ...VALID_ENV, WORKSPACE_ROOT: 'relative/workspace' })).toThrow(/WORKSPACE_ROOT/);
  });
  it('throws when MONGODB_URI is missing and names the variable', () => {
    expect(() =>
      loadConfig({
        JWT_ACCESS_TOKEN_SECRET: VALID_ENV.JWT_ACCESS_TOKEN_SECRET,
      }),
    ).toThrow(/MONGODB_URI/);
  });
  it('throws when JWT_ACCESS_TOKEN_SECRET is missing', () => {
    expect(() =>
      loadConfig({
        MONGODB_URI: VALID_ENV.MONGODB_URI,
      }),
    ).toThrow(/JWT_ACCESS_TOKEN_SECRET/);
  });
  it('reads repository encryption overrides from env', () => {
    const key = Buffer.alloc(32, 3).toString('base64');
    const cfg = loadConfig({
      ...VALID_ENV,
      REPO_CREDENTIAL_ENCRYPTION_KEY: key,
      REPO_CREDENTIAL_KEY_ID: 'k2',
      REPO_PROBE_ALLOW_PRIVATE_HOSTS: 'true',
    });
    expect(cfg.repositories.keyId).toBe('k2');
    expect(cfg.repositories.allowPrivateHosts).toBe(true);
    expect(cfg.repositories.encryptionKey.equals(Buffer.alloc(32, 3))).toBe(true);
  });
  it('throws when REPO_CREDENTIAL_ENCRYPTION_KEY is missing outside test', () => {
    expect(() =>
      loadConfig({
        ...VALID_ENV,
        NODE_ENV: 'development',
        REPO_CREDENTIAL_ENCRYPTION_KEY: '',
      }),
    ).toThrow(/REPO_CREDENTIAL_ENCRYPTION_KEY/);
  });
  it('throws when REPO_CREDENTIAL_ENCRYPTION_KEY is the wrong length', () => {
    expect(() =>
      loadConfig({
        ...VALID_ENV,
        NODE_ENV: 'development',
        REPO_CREDENTIAL_ENCRYPTION_KEY: 'short',
      }),
    ).toThrow(/REPO_CREDENTIAL_ENCRYPTION_KEY/);
  });
  it('throws when JWT_ACCESS_TOKEN_SECRET is too short', () => {
    expect(() =>
      loadConfig({
        ...VALID_ENV,
        JWT_ACCESS_TOKEN_SECRET: 'too-short',
      }),
    ).toThrow(/JWT_ACCESS_TOKEN_SECRET/);
  });
  it('does not put the JWT secret value in the thrown message', () => {
    const secret = 'super-secret-jwt-value-that-must-not-leak-xx';
    try {
      loadConfig({
        MONGODB_URI: VALID_ENV.MONGODB_URI,
        JWT_ACCESS_TOKEN_SECRET: 'short',
      });
      expect.unreachable('expected loadConfig to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(secret);
      expect(message).not.toContain('short');
      expect(message).toContain('JWT_ACCESS_TOKEN_SECRET');
    }
  });
  it('throws listing all invalid variables when several are wrong at once', () => {
    expect(() =>
      loadConfig({
        API_HOST: '   ',
        API_PORT: 'abc',
        MONGODB_URI: '',
        JWT_ACCESS_TOKEN_SECRET: '',
      }),
    ).toThrow(/Invalid configuration:\nAPI_HOST:.*\nAPI_PORT:.*\nMONGODB_URI:.*\nJWT_ACCESS_TOKEN_SECRET:/s);
  });
  it('rejects a non-numeric or out-of-range API_PORT', () => {
    expect(() => loadConfig({ ...VALID_ENV, API_PORT: 'abc' })).toThrow(/API_PORT/);
    expect(() => loadConfig({ ...VALID_ENV, API_PORT: '0' })).toThrow(/API_PORT/);
    expect(() => loadConfig({ ...VALID_ENV, API_PORT: '70000' })).toThrow(/API_PORT/);
  });
  it('does not put the MONGODB_URI value in the thrown message', () => {
    const secret = 'mongodb://user:s3cret@host/db?replicaSet=rs0';
    try {
      loadConfig({ API_HOST: '   ', MONGODB_URI: secret });
      expect.unreachable('expected loadConfig to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(secret);
      expect(message).not.toContain('s3cret');
      expect(message).toContain('API_HOST');
    }
  });
  it('does not expose pool size, socket timeout, API_BASE_PATH, or shutdown timeout', () => {
    const cfg = loadConfig({ ...VALID_ENV });
    const serialized = JSON.stringify(cfg);
    expect(serialized).not.toMatch(/pool|SOCKET|API_BASE_PATH|SHUTDOWN/i);
    expect(cfg).not.toHaveProperty('poolSize');
    expect(Object.keys(cfg)).toEqual(['env', 'server', 'logging', 'mongo', 'auth', 'workspace', 'repositories']);
  });
  it('falls back to process.env by default when MONGODB_URI is set', () => {
    const previousUri = process.env.MONGODB_URI;
    const previousJwt = process.env.JWT_ACCESS_TOKEN_SECRET;
    process.env.MONGODB_URI = VALID_ENV.MONGODB_URI;
    process.env.JWT_ACCESS_TOKEN_SECRET = VALID_ENV.JWT_ACCESS_TOKEN_SECRET;
    try {
      const cfg = loadConfig();
      expect(typeof cfg.server.port).toBe('number');
      expect(cfg.mongo.uri.length).toBeGreaterThan(0);
      expect(cfg.auth.jwtAccessTokenSecret.length).toBeGreaterThanOrEqual(32);
    } finally {
      if (previousUri === undefined) {
        delete process.env.MONGODB_URI;
      } else {
        process.env.MONGODB_URI = previousUri;
      }
      if (previousJwt === undefined) {
        delete process.env.JWT_ACCESS_TOKEN_SECRET;
      } else {
        process.env.JWT_ACCESS_TOKEN_SECRET = previousJwt;
      }
    }
  });
  it('throws when API_HOST is blank', () => {
    expect(() => loadConfig({ ...VALID_ENV, API_HOST: '   ' })).toThrow(/API_HOST/);
  });
});
describe('parseAppRunningPlatform', () => {
  it('returns container for container (case-insensitive)', () => {
    expect(parseAppRunningPlatform('container')).toBe('container');
    expect(parseAppRunningPlatform('CONTAINER')).toBe('container');
  });
  it('falls back to standalone for unknown or missing values', () => {
    expect(parseAppRunningPlatform(undefined)).toBe('standalone');
    expect(parseAppRunningPlatform('local')).toBe('standalone');
  });
});
describe('parseLogLevel', () => {
  it('accepts known levels', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('WARNING')).toBe('warning');
  });
  it('falls back to info for unknown values', () => {
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel('verbose')).toBe('info');
  });
});
describe('parsePort', () => {
  it('defaults to 3000', () => {
    expect(parsePort(undefined)).toBe(3000);
  });
  it('parses a valid port', () => {
    expect(parsePort('4000')).toBe(4000);
  });
  it('throws for invalid ports', () => {
    expect(() => parsePort('abc')).toThrow(/API_PORT/);
  });
});
describe('resolveRepositoryCrypto', () => {
  it('reads the key without requiring Mongo or JWT', () => {
    const crypto = resolveRepositoryCrypto({
      REPO_CREDENTIAL_ENCRYPTION_KEY: VALID_ENV.REPO_CREDENTIAL_ENCRYPTION_KEY,
      REPO_CREDENTIAL_KEY_ID: 'k2',
    });
    expect(crypto.keyId).toBe('k2');
    expect(crypto.encryptionKey.length).toBe(32);
  });
  it('uses the test default key when NODE_ENV=test and the env key is absent', () => {
    const crypto = resolveRepositoryCrypto({ NODE_ENV: 'test' });
    expect(crypto.keyId).toBe('k1');
    expect(crypto.encryptionKey.equals(Buffer.alloc(32, 7))).toBe(true);
  });
  it('throws when the key is missing outside test', () => {
    expect(() => resolveRepositoryCrypto({ NODE_ENV: 'development' })).toThrow(/REPO_CREDENTIAL_ENCRYPTION_KEY/);
  });
  it('throws when the key is the wrong length', () => {
    expect(() =>
      resolveRepositoryCrypto({
        NODE_ENV: 'development',
        REPO_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
      }),
    ).toThrow(/must be 32-byte base64/);
  });
});
