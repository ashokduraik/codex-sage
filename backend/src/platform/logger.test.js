import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  buildLoggerOptions,
  registerRequestLogging,
  serializeError,
  serializeRequest,
  shouldIncludeStack,
  toPinoLevel,
  LOG_REDACT_PATHS,
} from './logger.js';
import { TEST_APP_CONFIG } from '../test/appConfig.js';
import { ApiError } from './errors.js';
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
    it('uses LOG_LEVEL for container console-only logging', () => {
        const opts = buildLoggerOptions(cfg({ logging: { level: 'debug' } }));
        expect(opts.level).toBe('debug');
        expect(opts.transport).toBeUndefined();
    });
    it('maps warning level to Pino warn', () => {
        const opts = buildLoggerOptions(cfg({ logging: { level: 'warning' } }));
        expect(opts.level).toBe('warn');
    });
    it('ignores noConsoleLog in container mode', () => {
        const opts = buildLoggerOptions(cfg({
            env: { appRunningPlatform: 'container' },
            logging: { noConsoleLog: true },
        }));
        expect(opts.transport).toBeUndefined();
        expect(opts.level).toBe('info');
    });
    it('adds pino-roll transport in standalone mode', () => {
        const opts = buildLoggerOptions(cfg({
            env: { appRunningPlatform: 'standalone' },
            logging: { noConsoleLog: false },
        }));
        const targets = opts.transport.targets.map((t) => t.target);
        expect(targets).toContain('pino/file');
        expect(targets).toContain('pino-roll');
        expect(opts.level).toBe('info');
        expect(opts.formatters).toBeUndefined();
    });
    it('omits console target when standalone and noConsoleLog', () => {
        const opts = buildLoggerOptions(cfg({
            env: { appRunningPlatform: 'standalone' },
            logging: { noConsoleLog: true },
        }));
        const targets = opts.transport.targets.map((t) => t.target);
        expect(targets).not.toContain('pino/file');
        expect(targets).toEqual(['pino-roll']);
    });
    it('level formatter returns label string instead of a numeric code', () => {
        const opts = buildLoggerOptions(cfg({ env: { appRunningPlatform: 'container' } }));
        expect(opts.formatters.level('info')).toEqual({ level: 'info' });
        expect(opts.formatters.level('error')).toEqual({ level: 'error' });
    });
    it('bindings formatter strips pid and retains hostname', () => {
        const opts = buildLoggerOptions(cfg({ env: { appRunningPlatform: 'container' } }));
        const result = opts.formatters.bindings({ pid: 1234, hostname: 'my-host' });
        expect(result).toEqual({ hostname: 'my-host' });
        expect(result['pid']).toBeUndefined();
    });
    it('timestamp produces an ISO 8601 string field', () => {
        const opts = buildLoggerOptions(cfg({ env: { appRunningPlatform: 'container' } }));
        const raw = opts.timestamp();
        expect(raw).toMatch(/^,"time":"[\d]{4}-[\d]{2}-[\d]{2}T[\d]{2}:[\d]{2}:[\d]{2}/);
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
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ req: expect.objectContaining({ method: 'GET' }) }),
      'incoming request',
    );
    debug.mockClear();
    onResponse({ log: { debug } }, { statusCode: 200, elapsedTime: 12.5 }, done);
    expect(debug).toHaveBeenCalledWith(
      { res: { statusCode: 200, elapsedTime: 12.5 }, responseTime: 12.5 },
      'request completed',
    );
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
    const denied = serializeError(
      ApiError.fromCode('NOT_FOUND', { details: { path: '/x' } }),
    );
    expect(denied.details).toBeUndefined();
    const allowed = serializeError(
      ApiError.fromCode('VALIDATION_ERROR', { details: { field: 'email' } }),
    );
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
});

describe('shouldIncludeStack', () => {
  it('includes stacks in non-production and only at error in production', () => {
    expect(
      shouldIncludeStack({
        env: { isProduction: false },
        logging: { level: 'info' },
      }),
    ).toBe(true);
    expect(
      shouldIncludeStack(
        { env: { isProduction: true }, logging: { level: 'info' } },
        'info',
      ),
    ).toBe(false);
    expect(
      shouldIncludeStack(
        { env: { isProduction: true }, logging: { level: 'info' } },
        'error',
      ),
    ).toBe(true);
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
      token: 'tok',
      connectionString: 'mongodb://user:pass@host/db',
    });
    const joined = lines.join('');
    expect(joined).toContain('[redacted]');
    expect(joined).not.toContain('secret');
    expect(joined).not.toContain('mongodb://user:pass');
  });
});
