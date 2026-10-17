import { describe, expect, it } from 'vitest';
import {
  WORKER_LEASE_TTL_MS,
  assertLeaseExceedsHeartbeat,
  assertWorkerLeaseTimingSafe,
  WORKER_HEARTBEAT_INTERVAL_MS,
} from '../../src/worker/workerConfig.js';

describe('worker.constants', () => {
  it('requires lease TTL to exceed the heartbeat interval', () => {
    expect(WORKER_LEASE_TTL_MS).toBeGreaterThan(WORKER_HEARTBEAT_INTERVAL_MS);
    expect(() => assertWorkerLeaseTimingSafe()).not.toThrow();
  });

  it('throws when lease TTL does not exceed heartbeat', () => {
    expect(() => assertLeaseExceedsHeartbeat(1000, 1000)).toThrow(/must exceed/);
    expect(() => assertLeaseExceedsHeartbeat(500, 1000)).toThrow(/must exceed/);
  });
});
