import { describe, it, expect } from 'vitest';
import {
  loadConfig,
  parseAppRunningPlatform,
  parseLogLevel,
  parsePort,
} from './config';

describe('loadConfig', () => {
  it('uses defaults when env is empty', () => {
    const cfg = loadConfig({});
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.port).toBe(3000);
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.logger).toBe(true);
    expect(cfg.appRunningPlatform).toBe('standalone');
    expect(cfg.logLevel).toBe('info');
    expect(cfg.noConsoleLog).toBe(false);
  });

  it('reads overrides from env', () => {
    const cfg = loadConfig({
      API_HOST: '127.0.0.1',
      API_PORT: '8080',
      NODE_ENV: 'production',
      APP_RUNNING_PLATFORM: 'container',
      LOG_LEVEL: 'warning',
      NO_CONSOLE_LOG: 'true',
    });
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(8080);
    expect(cfg.nodeEnv).toBe('production');
    expect(cfg.logger).toBe(true);
    expect(cfg.appRunningPlatform).toBe('container');
    expect(cfg.logLevel).toBe('warning');
    expect(cfg.noConsoleLog).toBe(true);
  });

  it('disables the logger and sets nodeEnv=test under NODE_ENV=test', () => {
    const cfg = loadConfig({ NODE_ENV: 'test' });
    expect(cfg.logger).toBe(false);
    expect(cfg.nodeEnv).toBe('test');
  });

  it('falls back to process.env by default', () => {
    const cfg = loadConfig();
    expect(typeof cfg.port).toBe('number');
  });

  it('throws when API_HOST is blank', () => {
    expect(() => loadConfig({ API_HOST: '   ' })).toThrow(/API_HOST/);
  });

  it('throws when API_PORT is invalid', () => {
    expect(() => loadConfig({ API_PORT: 'abc' })).toThrow(/API_PORT/);
    expect(() => loadConfig({ API_PORT: '0' })).toThrow(/API_PORT/);
    expect(() => loadConfig({ API_PORT: '70000' })).toThrow(/API_PORT/);
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
});
