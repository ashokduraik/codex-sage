/**
 * Lifecycle transition matrix and guards.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../platform/errors.js';
import {
  LIFECYCLE_TRANSITIONS,
  assertKnowledgeHealthAllowed,
  assertLifecycleTransitionAllowed,
  initialLifecycleAfterCreate,
  isKnownKnowledgeHealth,
  isKnownLifecycleStatus,
} from './projects.lifecycle.js';
import { LIFECYCLE_STATUS_VALUES } from './projects.model.js';

describe('projects.lifecycle', () => {
  it('exposes exactly the ten lifecycle states from backend §9', () => {
    expect(LIFECYCLE_STATUS_VALUES).toEqual([
      'creating',
      'awaiting_source',
      'connecting_repository',
      'source_received',
      'processing',
      'knowledge_ready',
      'updating',
      'failed',
      'partially_available',
      'archived',
    ]);
  });

  it('maps create sourceType to the first post-creating state', () => {
    expect(initialLifecycleAfterCreate('upload')).toBe('awaiting_source');
    expect(initialLifecycleAfterCreate('repository')).toBe('connecting_repository');
  });

  it('allows every transition in the table', () => {
    for (const [from, nextStates] of Object.entries(LIFECYCLE_TRANSITIONS)) {
      for (const to of nextStates) {
        const needsWorker = to === 'knowledge_ready' || to === 'partially_available';
        expect(() =>
          assertLifecycleTransitionAllowed({
            from,
            to,
            source: needsWorker ? 'worker' : 'api',
            knowledgeVersionId: needsWorker ? '6650f1a2c3d4e5f601020399' : undefined,
          }),
        ).not.toThrow();
      }
    }
  });

  it('rejects a representative invalid transition from each state', () => {
    const invalidTargets = {
      creating: 'knowledge_ready',
      awaiting_source: 'processing',
      connecting_repository: 'updating',
      source_received: 'knowledge_ready',
      processing: 'awaiting_source',
      knowledge_ready: 'source_received',
      updating: 'creating',
      partially_available: 'creating',
      failed: 'source_received',
      archived: 'awaiting_source',
    };

    for (const [from, to] of Object.entries(invalidTargets)) {
      try {
        assertLifecycleTransitionAllowed({ from, to, source: 'api' });
        expect.unreachable(`expected invalid transition ${from} → ${to}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.details).toMatchObject({ from, to });
      }
    }
  });

  it('rejects knowledge_ready and partially_available from api source', () => {
    for (const to of ['knowledge_ready', 'partially_available']) {
      try {
        assertLifecycleTransitionAllowed({
          from: 'processing',
          to,
          source: 'api',
          knowledgeVersionId: '6650f1a2c3d4e5f601020399',
        });
        expect.unreachable();
      } catch (err) {
        expect(err.code).toBe('INVALID_STATE_TRANSITION');
        expect(err.details.reason).toBe('worker_source_required');
      }
    }
  });

  it('rejects knowledge_ready when knowledgeVersionId is missing', () => {
    try {
      assertLifecycleTransitionAllowed({
        from: 'processing',
        to: 'knowledge_ready',
        source: 'worker',
      });
      expect.unreachable();
    } catch (err) {
      expect(err.code).toBe('INVALID_STATE_TRANSITION');
      expect(err.details.reason).toBe('knowledge_version_required');
    }
  });

  it('rejects knowledgeHealth ready or partially_available while lifecycle is pre-processing', () => {
    for (const lifecycleStatus of [
      'creating',
      'awaiting_source',
      'connecting_repository',
      'source_received',
    ]) {
      for (const knowledgeHealth of ['ready', 'partially_available']) {
        try {
          assertKnowledgeHealthAllowed({ lifecycleStatus, knowledgeHealth });
          expect.unreachable();
        } catch (err) {
          expect(err.code).toBe('INVALID_STATE_TRANSITION');
        }
      }
    }
  });

  it('allows knowledgeHealth ready or partially_available after processing has started', () => {
    expect(() =>
      assertKnowledgeHealthAllowed({
        lifecycleStatus: 'processing',
        knowledgeHealth: 'ready',
      }),
    ).not.toThrow();
    expect(() =>
      assertKnowledgeHealthAllowed({
        lifecycleStatus: 'processing',
        knowledgeHealth: 'partially_available',
      }),
    ).not.toThrow();
  });

  it('recognizes known lifecycle and knowledgeHealth codes', () => {
    expect(isKnownLifecycleStatus('knowledge_ready')).toBe(true);
    expect(isKnownLifecycleStatus('nope')).toBe(false);
    expect(isKnownKnowledgeHealth('ready')).toBe(true);
    expect(isKnownKnowledgeHealth('current')).toBe(false);
  });
});
