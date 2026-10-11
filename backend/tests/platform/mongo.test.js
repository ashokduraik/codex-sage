import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { TEST_APP_CONFIG } from '../appConfig.js';
import {
  checkMongoHealth,
  connectMongo,
  describeMongoUri,
  disconnectMongo,
  mapReadyState,
  MONGO_UNAVAILABLE_CODE,
  resetMongoListenersForTests,
  MONGODB_MAX_POOL_SIZE,
} from '../../src/platform/mongo.js';
vi.mock('mongoose', () => {
  const connection = {
    readyState: 0,
    db: undefined,
    on: vi.fn(),
  };
  return {
    default: {
      connection,
      connect: vi.fn(),
      disconnect: vi.fn(),
      set: vi.fn(),
    },
  };
});
/** Typed access to the mocked mongoose connection for test setup. */
function mockConnection() {
  return mongoose.connection;
}
describe('describeMongoUri', () => {
  it('returns database and replicaSet without hosts or credentials', () => {
    expect(describeMongoUri('mongodb://user:pass@host1:27017/codex_sage?replicaSet=rs0')).toEqual({ database: 'codex_sage', replicaSet: 'rs0' });
  });
  it('handles unparseable URIs safely', () => {
    expect(describeMongoUri('not-a-uri')).toEqual({ database: '(unparseable)' });
  });
  it('omits replicaSet when absent and uses (default) for empty path', () => {
    expect(describeMongoUri('mongodb://127.0.0.1:27017/')).toEqual({
      database: '(default)',
    });
  });
});
describe('mapReadyState', () => {
  it('maps every Mongoose readyState value', () => {
    expect(mapReadyState(0)).toBe('disconnected');
    expect(mapReadyState(1)).toBe('connected');
    expect(mapReadyState(2)).toBe('connecting');
    expect(mapReadyState(3)).toBe('disconnecting');
    expect(mapReadyState(99)).toBe('disconnected');
  });
});
describe('connectMongo / disconnectMongo', () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    resetMongoListenersForTests();
    mockConnection().readyState = 0;
    mockConnection().db = undefined;
  });
  afterEach(() => {
    resetMongoListenersForTests();
  });
  it('connects with pool constants and logs a redacted summary', async () => {
    vi.mocked(mongoose.connect).mockResolvedValue(mongoose);
    mockConnection().readyState = 1;
    await connectMongo(TEST_APP_CONFIG, log);
    expect(mongoose.set).toHaveBeenCalledWith('bufferCommands', false);
    expect(mongoose.set).toHaveBeenCalledWith('autoIndex', false);
    expect(mongoose.connect).toHaveBeenCalledWith(TEST_APP_CONFIG.mongo.uri, expect.objectContaining({ maxPoolSize: MONGODB_MAX_POOL_SIZE }));
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        database: 'codex_sage_test',
        poolSize: MONGODB_MAX_POOL_SIZE,
        state: 'connected',
      }),
      'mongo connected',
    );
    const logged = JSON.stringify(log.info.mock.calls);
    expect(logged).not.toContain(TEST_APP_CONFIG.mongo.uri);
  });
  it('logs and rethrows when the first connect fails', async () => {
    vi.mocked(mongoose.connect).mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(connectMongo(TEST_APP_CONFIG, log)).rejects.toThrow(/ECONNREFUSED/);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errName: 'Error',
        errMessage: 'ECONNREFUSED',
        errStack: expect.stringContaining('ECONNREFUSED'),
        database: 'codex_sage_test',
      }),
      'mongo connect failed',
    );
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain(TEST_APP_CONFIG.mongo.uri);
  });
  it('disconnectMongo is idempotent when already disconnected', async () => {
    mockConnection().readyState = 0;
    await expect(disconnectMongo()).resolves.toBeUndefined();
    expect(mongoose.disconnect).not.toHaveBeenCalled();
  });
  it('disconnectMongo closes an open connection and is safe to call twice', async () => {
    mockConnection().readyState = 1;
    vi.mocked(mongoose.disconnect).mockImplementation(async () => {
      mockConnection().readyState = 0;
    });
    await disconnectMongo();
    await disconnectMongo();
    expect(mongoose.disconnect).toHaveBeenCalledTimes(1);
  });
  it('disables autoIndex in production', async () => {
    vi.mocked(mongoose.connect).mockResolvedValue(mongoose);
    mockConnection().readyState = 1;
    await connectMongo(
      {
        ...TEST_APP_CONFIG,
        env: { ...TEST_APP_CONFIG.env, isProduction: true, nodeEnv: 'production' },
      },
      log,
    );
    expect(mongoose.set).toHaveBeenCalledWith('autoIndex', false);
  });
  it('attaches connection listeners that log disconnect/reconnect/error', async () => {
    vi.mocked(mongoose.connect).mockResolvedValue(mongoose);
    mockConnection().readyState = 1;
    await connectMongo(TEST_APP_CONFIG, log);
    const onMock = mockConnection().on;
    const handlers = Object.fromEntries(onMock.mock.calls.map(([event, handler]) => [event, handler]));
    handlers['disconnected']?.();
    handlers['reconnected']?.();
    handlers['error']?.(new Error('socket hang up'));
    expect(log.warn).toHaveBeenCalledWith({}, 'mongo disconnected');
    expect(log.info).toHaveBeenCalledWith({}, 'mongo reconnected');
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errName: 'Error',
        errMessage: 'socket hang up',
        errStack: expect.stringContaining('socket hang up'),
      }),
      'mongo connection error',
    );
    // Second connect must not re-attach listeners.
    await connectMongo(TEST_APP_CONFIG, log);
    expect(onMock.mock.calls.length).toBe(3);
  });
  it('logs non-Error connect failures without leaking details', async () => {
    vi.mocked(mongoose.connect).mockRejectedValue('boom-string');
    await expect(connectMongo(TEST_APP_CONFIG, log)).rejects.toBe('boom-string');
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errName: 'Error',
        errMessage: 'boom-string',
      }),
      'mongo connect failed',
    );
  });
});
describe('checkMongoHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnection().readyState = 0;
    mockConnection().db = undefined;
  });
  it('returns ok false with MONGO_UNAVAILABLE when disconnected', async () => {
    const result = await checkMongoHealth();
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({ code: MONGO_UNAVAILABLE_CODE });
    expect(JSON.stringify(result)).not.toMatch(/ECONN|stack|mongodb:\/\//i);
  });
  it('returns ok true with latency when ping succeeds', async () => {
    mockConnection().readyState = 1;
    mockConnection().db = {
      admin: () => ({
        ping: async () => ({ ok: 1 }),
      }),
    };
    const result = await checkMongoHealth();
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });
  it('returns code-only error when ping rejects', async () => {
    mockConnection().readyState = 1;
    mockConnection().db = {
      admin: () => ({
        ping: async () => {
          throw new Error('not master and secondaryOk=false host=secret');
        },
      }),
    };
    const result = await checkMongoHealth();
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
        error: { code: MONGO_UNAVAILABLE_CODE },
      }),
    );
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('not master');
  });
});
