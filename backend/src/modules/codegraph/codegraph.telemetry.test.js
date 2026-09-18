/**
 * Unit tests for CodeGraph telemetry helpers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEGRAPH_TELEMETRY_ENV_KEYS,
  configureCodegraphTelemetryOff,
  isCodegraphTelemetryConfigured,
  resetCodegraphTelemetryConfiguredFlag,
} from './codegraph.telemetry.js';

describe('codegraph.telemetry', () => {
  afterEach(() => {
    resetCodegraphTelemetryConfiguredFlag();
  });

  it('sets telemetry-off env keys and marks configured', () => {
    expect(isCodegraphTelemetryConfigured()).toBe(false);
    configureCodegraphTelemetryOff();
    expect(process.env.CODEGRAPH_TELEMETRY).toBe('0');
    expect(process.env.DO_NOT_TRACK).toBe('1');
    expect(isCodegraphTelemetryConfigured()).toBe(true);
    expect(CODEGRAPH_TELEMETRY_ENV_KEYS).toContain('CODEGRAPH_TELEMETRY');
  });

  it('is idempotent across repeated configure calls', () => {
    configureCodegraphTelemetryOff();
    configureCodegraphTelemetryOff();
    expect(process.env.CODEGRAPH_TELEMETRY).toBe('0');
    expect(isCodegraphTelemetryConfigured()).toBe(true);
  });
});
