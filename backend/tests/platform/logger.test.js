import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
import {
  buildLoggerOptions,
  createAppLogger,
  createRequestChildLogger,
  registerRequestLogging,
  serializeError,
  serializeRequest,
  shouldIncludeStack,
  toPinoLevel,
  LOG_BACKUP_COUNT,
  LOG_DIR,
  LOG_REDACT_PATHS,
} from '../../src/platform/logger.js';
import { TEST_APP_CONFIG } from '../appConfig.js';
import { ApiError } from '../../src/platform/errors.js';

vi.mock('pino-roll', () => ({
  default: vi.fn(async () => {
    return new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  }),
}));

import createRollStream from 'pino-roll';

/**
 * Minimal config fixture for testing logger options only.
 * @param overrides - Nested partial overrides for env/logging groups.
 */
function cfg(overrides = {}) {
  return {
    ...TEST_APP_CONFIG,
    env: {
      ...TEST_APP_CONFIG.env,
      nodeEnv: 'development',
      isTest: false,
      appRunningPlatform: 'container',
      ...overrides.env,
    },
    logging: {
      ...TEST_APP_CONFIG.logging,
      logger: true,
      level: 'info',
      noConsoleLog: false,
      ...overrides.logging,
    },
  };
}

describe('toPinoLevel', () => {
  it('maps warning to warn for Pino', () => {
    expect(toPinoLevel('warning')).toBe('warn');
    expect(toPinoLevel('info')).toBe('info');
    expect(toPinoLevel('debug')).toBe('debug');
    expect(toPinoLevel('error')).toBe('error');
  });
});

describe('buildLoggerOptions', () => {
  it('returns false when logger is disabled', () => {
    expect(buildLoggerOptions(cfg({ logging: { logger: false } }))).toBe(false);
  });

  it('uses LOG_LEVEL and keeps formatters without a worker transport', () => {
    const opts = buildLoggerOptions(cfg({ logging: { level: 'debug' } }));
    expect(opts.level).toBe('debug');
    expect(opts.transport).toBeUndefined();
    expect(opts.base).toBeUndefined();
    expect(opts.formatters.level).toEqual(expect.any(Function));
  });

  it('maps warning level to Pino warn', () => {
    const opts = buildLoggerOptions(cfg({ logging: { level: 'warning' } }));
    expect(opts.level).toBe('warn');
  });

  it('returns the same readable option shape in standalone mode', () => {
    const opts = buildLoggerOptions(
      cfg({
        env: { appRunningPlatform: 'standalone' },
        logging: { noConsoleLog: false },
      }),
    );
    expect(opts.transport).toBeUndefined();
    expect(opts.level).toBe('info');
    expect(opts.formatters.level('warn')).toEqual({ level: 'warn' });
    expect(opts.base).toBeUndefined();
  });

  it('level formatter returns label string instead of a numeric code', () => {
    const opts = buildLoggerOptions(cfg({ env: { appRunningPlatform: 'container' } }));
    expect(opts.formatters.level('info')).toEqual({ level: 'info' });
    expect(opts.formatters.level('error')).toEqual({ level: 'error' });
  });

  it('bindings formatter strips pid and hostname', () => {
    const opts = buildLoggerOptions(cfg({ env: { appRunningPlatform: 'container' } }));
    const result = opts.formatters.bindings({ pid: 1234, hostname: 'my-host' });
    expect(result).toEqual({});
  });

  it('timestamp produces an ISO 8601 string field', () => {
    const opts = buildLoggerOptions(cfg({ env: { appRunningPlatform: 'container' } }));
    const raw = opts.timestamp();
    expect(raw).toMatch(/^,"time":"[\d]{4}-[\d]{2}-[\d]{2}T[\d]{2}:[\d]{2}:[\d]{2}/);
  });
});

describe('createAppLogger', () => {
  beforeEach(() => {
    vi.mocked(createRollStream).mockClear();
  });

  it('returns false when logger is disabled', async () => {
    expect(await createAppLogger(cfg({ logging: { logger: false } }))).toBe(false);
    expect(createRollStream).not.toHaveBeenCalled();
  });

  it('builds a stdout logger in container mode without pino-roll', async () => {
    const logger = await createAppLogger(cfg({ env: { appRunningPlatform: 'container' } }));
    expect(logger).toBeTruthy();
    expect(typeof logger.info).toBe('function');
    expect(createRollStream).not.toHaveBeenCalled();
  });

  it('attaches a rotating file stream in standalone mode', async () => {
    const logger = await createAppLogger(
      cfg({
        env: { appRunningPlatform: 'standalone' },
        logging: { noConsoleLog: false },
      }),
    );
    expect(logger).toBeTruthy();
    expect(createRollStream).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.stringContaining(LOG_DIR),
        extension: '.log',
        size: '5m',
        mkdir: true,
        limit: { count: LOG_BACKUP_COUNT },
      }),
    );
  });

  it('uses file-only stream when standalone and noConsoleLog', async () => {
    const logger = await createAppLogger(
      cfg({
        env: { appRunningPlatform: 'standalone' },
        logging: { noConsoleLog: true },
      }),
    );
    expect(logger).toBeTruthy();
    expect(createRollStream).toHaveBeenCalledTimes(1);
  });

  it('emits level labels, ISO time, and omits pid/hostname', async () => {
    const lines = [];
    const opts = buildLoggerOptions(cfg());
    const logger = pino(opts, {
      write(chunk) {
        lines.push(chunk);
      },
    });
    logger.info({ outcome: 'ok' }, 'sample');
    const parsed = JSON.parse(lines.join(''));
    expect(parsed.level).toBe('info');
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.pid).toBeUndefined();
    expect(parsed.hostname).toBeUndefined();
    expect(parsed.msg).toBe('sample');
  });
});

describe('createRequestChildLogger', () => {
  it('binds method and path-only url onto the child logger', () => {
    const child = vi.fn((bindings) => bindings);
    const logger = { child };
    const result = createRequestChildLogger(logger, { reqId: 'REQ-1' }, { level: 'info' }, { method: 'POST', url: '/api/v1/auth/login?x=1' });
    expect(child).toHaveBeenCalledWith(
      {
        reqId: 'REQ-1',
        method: 'POST',
        url: '/api/v1/auth/login',
      },
      { level: 'info' },
    );
    expect(result).toEqual({
      reqId: 'REQ-1',
      method: 'POST',
      url: '/api/v1/auth/login',
    });
  });

  it('omits url when raw request has no url string', () => {
    const child = vi.fn((bindings) => bindings);
    createRequestChildLogger({ child }, { reqId: 'REQ-2' }, {}, { method: 'GET' });
    expect(child).toHaveBeenCalledWith({ reqId: 'REQ-2', method: 'GET', url: undefined }, {});
  });
});

describe('registerRequestLogging', () => {
  it('registers onRequest and onResponse hooks that log at debug', () => {
    const debug = vi.fn();
    const app = {
      addHook: vi.fn(),
    };
    registerRequestLogging(app);
    expect(app.addHook).toHaveBeenCalledTimes(2);
    expect(app.addHook).toHaveBeenCalledWith('onRequest', expect.any(Function));
    expect(app.addHook).toHaveBeenCalledWith('onResponse', expect.any(Function));
    const hookCalls = vi.mocked(app.addHook).mock.calls;
    const onRequest = hookCalls[0][1];
    const onResponse = hookCalls[1][1];
    const done = vi.fn();
    onRequest({ log: { debug }, method: 'GET' }, {}, done);
    expect(debug).toHaveBeenCalledWith(expect.objectContaining({ req: expect.objectContaining({ method: 'GET' }) }), 'incoming request');
    debug.mockClear();
    onResponse({ log: { debug } }, { statusCode: 200, elapsedTime: 12.5 }, done);
    expect(debug).toHaveBeenCalledWith({ res: { statusCode: 200, elapsedTime: 12.5 }, responseTime: 12.5 }, 'request completed');
    expect(done).toHaveBeenCalledTimes(2);
  });
});

describe('serializeRequest', () => {
  it('omits query string, authorization header and cookies', () => {
    const serialized = serializeRequest({
      method: 'GET',
      id: 'REQ-abc',
      url: '/search?q=secret',
      routeOptions: { url: '/search' },
      headers: { authorization: 'Bearer tok', cookie: 'a=1' },
      ip: '127.0.0.1',
    });
    expect(serialized).toEqual({
      method: 'GET',
      path: '/search',
      reqId: 'REQ-abc',
      remoteAddress: '127.0.0.1',
    });
    expect(JSON.stringify(serialized)).not.toMatch(/secret|Bearer|cookie/i);
  });

  it('returns an empty object for non-objects and falls back to routerPath', () => {
    expect(serializeRequest(null)).toEqual({});
    expect(serializeRequest('x')).toEqual({});
    expect(
      serializeRequest({
        method: 'POST',
        id: 'REQ-1',
        routerPath: '/items',
        socket: { remoteAddress: '::1' },
      }),
    ).toMatchObject({ path: '/items', remoteAddress: '::1' });
  });
});

describe('serializeError', () => {
  it('drops details unless the catalog allows them', () => {
    const denied = serializeError(ApiError.fromCode('NOT_FOUND', { details: { path: '/x' } }));
    expect(denied.details).toBeUndefined();
    const allowed = serializeError(ApiError.fromCode('VALIDATION_ERROR', { details: { field: 'email' } }));
    expect(allowed.details).toEqual({ field: 'email' });
  });

  it('omits stack when includeStack is false', () => {
    const err = new Error('x');
    const out = serializeError(err, { includeStack: false });
    expect(out.stack).toBeUndefined();
  });

  it('stringifies non-object errors', () => {
    expect(serializeError('boom')).toEqual({ message: 'boom' });
  });

  it('includes nested cause so wrapped catalog errors stay debuggable', () => {
    const cause = new Error('upstream 500');
    const wrapped = ApiError.fromCode('LLM_PROVIDER_ERROR', { cause });
    const out = serializeError(wrapped);
    expect(out.code).toBe('LLM_PROVIDER_ERROR');
    expect(out.cause).toMatchObject({ type: 'Error', message: 'upstream 500' });
    expect(out.cause.stack).toEqual(expect.stringContaining('upstream 500'));
  });
});

describe('shouldIncludeStack', () => {
  it('includes stacks in non-production and only at error in production', () => {
    expect(
      shouldIncludeStack({
        env: { isProduction: false },
        logging: { level: 'info' },
      }),
    ).toBe(true);
    expect(shouldIncludeStack({ env: { isProduction: true }, logging: { level: 'info' } }, 'info')).toBe(false);
    expect(shouldIncludeStack({ env: { isProduction: true }, logging: { level: 'info' } }, 'error')).toBe(true);
    expect(
      shouldIncludeStack({
        env: { isProduction: true },
        logging: { level: 'debug' },
      }),
    ).toBe(true);
  });
});

describe('pino redact', () => {
  it('redacts password, token and connectionString fields', () => {
    const opts = buildLoggerOptions(cfg({ env: { appRunningPlatform: 'container' } }));
    expect(opts.redact.paths).toEqual(LOG_REDACT_PATHS);
    const lines = [];
    const logger = pino(
      {
        level: 'info',
        redact: opts.redact,
        serializers: opts.serializers,
      },
      {
        write(chunk) {
          lines.push(chunk);
        },
      },
    );
    logger.info({
      password: 'secret',
      newPassword: 'new-secret',
      token: 'tok',
      accessToken: 'access-tok',
      refreshToken: 'refresh-tok',
      passwordHash: 'argon-hash',
      connectionString: 'mongodb://user:pass@host/db',
    });
    const joined = lines.join('');
    expect(joined).toContain('[redacted]');
    expect(joined).not.toContain('secret');
    expect(joined).not.toContain('new-secret');
    expect(joined).not.toContain('access-tok');
    expect(joined).not.toContain('refresh-tok');
    expect(joined).not.toContain('argon-hash');
    expect(joined).not.toContain('mongodb://user:pass');
  });

  it('includes newPassword in LOG_REDACT_PATHS', () => {
    expect(LOG_REDACT_PATHS).toContain('newPassword');
    expect(LOG_REDACT_PATHS).toContain('*.newPassword');
  });
});
