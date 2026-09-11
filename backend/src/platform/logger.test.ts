import { describe, it, expect, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildLoggerOptions, registerRequestLogging, toPinoLevel } from './logger';
import type { AppConfig } from './config';

/** Minimal config fixture for testing logger options only. */
function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '0.0.0.0',
    port: 3000,
    nodeEnv: 'development',
    logger: true,
    appRunningPlatform: 'container',
    logLevel: 'info',
    noConsoleLog: false,
    ...overrides,
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
    expect(buildLoggerOptions(cfg({ logger: false }))).toBe(false);
  });

  it('uses LOG_LEVEL for container console-only logging', () => {
    const opts = buildLoggerOptions(cfg({ logLevel: 'debug' })) as Record<string, unknown>;
    expect(opts.level).toBe('debug');
    expect(opts.transport).toBeUndefined();
  });

  it('maps warning level to Pino warn', () => {
    const opts = buildLoggerOptions(cfg({ logLevel: 'warning' })) as Record<string, unknown>;
    expect(opts.level).toBe('warn');
  });

  it('ignores noConsoleLog in container mode', () => {
    const opts = buildLoggerOptions(
      cfg({ appRunningPlatform: 'container', noConsoleLog: true }),
    ) as Record<string, unknown>;
    expect(opts.transport).toBeUndefined();
    expect(opts.level).toBe('info');
  });

  it('adds pino-roll transport in standalone mode', () => {
    const opts = buildLoggerOptions(
      cfg({ appRunningPlatform: 'standalone', noConsoleLog: false }),
    ) as {
      level: string;
      transport: { targets: Array<{ target: string }> };
      formatters?: unknown;
    };
    const targets = opts.transport.targets.map((t) => t.target);
    expect(targets).toContain('pino/file');
    expect(targets).toContain('pino-roll');
    expect(opts.level).toBe('info');
    expect(opts.formatters).toBeUndefined();
  });

  it('omits console target when standalone and noConsoleLog', () => {
    const opts = buildLoggerOptions(
      cfg({ appRunningPlatform: 'standalone', noConsoleLog: true }),
    ) as {
      transport: { targets: Array<{ target: string }> };
    };
    const targets = opts.transport.targets.map((t) => t.target);
    expect(targets).not.toContain('pino/file');
    expect(targets).toEqual(['pino-roll']);
  });

  it('level formatter returns label string instead of a numeric code', () => {
    const opts = buildLoggerOptions(cfg({ appRunningPlatform: 'container' })) as {
      formatters: { level: (label: string) => { level: string } };
    };
    expect(opts.formatters.level('info')).toEqual({ level: 'info' });
    expect(opts.formatters.level('error')).toEqual({ level: 'error' });
  });

  it('bindings formatter strips pid and retains hostname', () => {
    const opts = buildLoggerOptions(cfg({ appRunningPlatform: 'container' })) as {
      formatters: { bindings: (b: Record<string, unknown>) => Record<string, unknown> };
    };
    const result = opts.formatters.bindings({ pid: 1234, hostname: 'my-host' });
    expect(result).toEqual({ hostname: 'my-host' });
    expect(result['pid']).toBeUndefined();
  });

  it('timestamp produces an ISO 8601 string field', () => {
    const opts = buildLoggerOptions(cfg({ appRunningPlatform: 'container' })) as {
      timestamp: () => string;
    };
    const raw = opts.timestamp();
    expect(raw).toMatch(/^,"time":"[\d]{4}-[\d]{2}-[\d]{2}T[\d]{2}:[\d]{2}:[\d]{2}/);
  });
});

describe('registerRequestLogging', () => {
  it('registers onRequest and onResponse hooks that log at debug', () => {
    const debug = vi.fn();
    const app = {
      addHook: vi.fn(),
    } as unknown as FastifyInstance;

    registerRequestLogging(app);

    expect(app.addHook).toHaveBeenCalledTimes(2);
    expect(app.addHook).toHaveBeenCalledWith('onRequest', expect.any(Function));
    expect(app.addHook).toHaveBeenCalledWith('onResponse', expect.any(Function));

    const hookCalls = vi.mocked(app.addHook).mock.calls;
    const onRequest = hookCalls[0]![1] as (
      req: { log: { debug: typeof debug }; method: string },
      reply: unknown,
      done: () => void,
    ) => void;
    const onResponse = hookCalls[1]![1] as (
      req: { log: { debug: typeof debug } },
      reply: { statusCode: number; elapsedTime: number },
      done: () => void,
    ) => void;
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
