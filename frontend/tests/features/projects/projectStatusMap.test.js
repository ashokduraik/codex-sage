/**
 * projectStatusMap — codes, unknown fallback, askable predicate.
 */
import { describe, expect, it } from 'vitest';
import {
  isProjectArchived,
  isProjectAskable,
  mapKnowledgeHealth,
  mapLifecycleStatus,
  KNOWLEDGE_HEALTH_MAP,
  LIFECYCLE_STATUS_MAP,
} from '@/shared/components/StatusBadge.jsx';

describe('projectStatusMap', () => {
  it('maps every known lifecycle code to a distinct label key and tone', () => {
    const entries = Object.entries(LIFECYCLE_STATUS_MAP);
    expect(entries).toHaveLength(10);
    const keys = new Set(entries.map(([, meta]) => meta.i18nKey));
    expect(keys.size).toBe(10);
    expect(mapLifecycleStatus('knowledge_ready').tone).toBe('success');
    expect(mapLifecycleStatus('partially_available').tone).toBe('attention');
    expect(mapLifecycleStatus('knowledge_ready').i18nKey).not.toBe(
      mapLifecycleStatus('partially_available').i18nKey,
    );
  });

  it('maps every known knowledge-health code', () => {
    expect(Object.keys(KNOWLEDGE_HEALTH_MAP)).toHaveLength(6);
    expect(mapKnowledgeHealth('ready').tone).toBe('success');
    expect(mapKnowledgeHealth('partially_available').tone).toBe('attention');
    expect(mapKnowledgeHealth('stale').i18nKey).toBe('status.knowledgeHealth.stale');
  });

  it('returns the neutral unknown entry for unfamiliar codes', () => {
    expect(mapLifecycleStatus('future_state')).toEqual({
      i18nKey: 'status.lifecycle.unknown',
      tone: 'neutral',
    });
    expect(mapKnowledgeHealth('weird')).toEqual({
      i18nKey: 'status.knowledgeHealth.unknown',
      tone: 'neutral',
    });
    expect(mapLifecycleStatus(null).i18nKey).toBe('status.lifecycle.unknown');
    expect(mapKnowledgeHealth('').i18nKey).toBe('status.knowledgeHealth.unknown');
  });

  it('treats archived and non-ready health as not askable', () => {
    expect(
      isProjectAskable({ lifecycleStatus: 'knowledge_ready', knowledgeHealth: 'ready' }),
    ).toBe(true);
    expect(
      isProjectAskable({
        lifecycleStatus: 'partially_available',
        knowledgeHealth: 'partially_available',
      }),
    ).toBe(true);
    expect(
      isProjectAskable({ lifecycleStatus: 'archived', knowledgeHealth: 'ready' }),
    ).toBe(false);
    for (const health of ['none', 'updating', 'stale', 'failed']) {
      expect(
        isProjectAskable({ lifecycleStatus: 'knowledge_ready', knowledgeHealth: health }),
      ).toBe(false);
    }
    expect(isProjectAskable(null)).toBe(false);
    expect(isProjectArchived({ lifecycleStatus: 'archived' })).toBe(true);
    expect(isProjectArchived({ lifecycleStatus: 'processing' })).toBe(false);
  });
});
