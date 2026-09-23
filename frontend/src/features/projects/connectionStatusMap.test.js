/**
 * Unit tests for connection status labels.
 */
import { describe, expect, it } from 'vitest';
import { connectionStatusLabelKey } from './connectionStatusMap.js';

describe('connectionStatusLabelKey', () => {
  it('maps known codes and falls back for unknown', () => {
    expect(connectionStatusLabelKey('connected')).toBe('sources.connectionStatus.connected');
    expect(connectionStatusLabelKey('authentication_required')).toBe(
      'sources.connectionStatus.authenticationRequired',
    );
    expect(connectionStatusLabelKey('mystery')).toBe('sources.connectionStatus.unknown');
    expect(connectionStatusLabelKey(null)).toBe('sources.connectionStatus.unknown');
  });
});
