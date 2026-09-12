/**
 * Project DTO mapping.
 */
import { describe, expect, it } from 'vitest';
import { mapProjectToDto } from './projects.types.js';

describe('mapProjectToDto', () => {
  const base = {
    _id: '6650f1a2c3d4e5f601020304',
    name: 'Atlas',
    description: 'Checkout',
    lifecycleStatus: 'awaiting_source',
    knowledgeHealth: 'none',
    sourceConfig: { sourceType: 'upload' },
    counts: { sourceVersions: 0, files: 0, excludedFiles: 0, conversations: 0 },
    createdBy: '6650f0aa0000000000000001',
    createdAt: new Date('2026-09-11T09:12:04.000Z'),
    updatedAt: new Date('2026-09-11T09:12:04.000Z'),
  };

  it('maps the list shape without detail fields', () => {
    const dto = mapProjectToDto(base);
    expect(dto.id).toBe(base._id);
    expect(dto.lifecycleStatus).toBe('awaiting_source');
    expect(dto.archivedAt).toBeUndefined();
    expect(dto.settings).toBeUndefined();
  });

  it('includes detail fields when requested', () => {
    const dto = mapProjectToDto(
      {
        ...base,
        archivedAt: new Date('2026-09-11T10:00:00.000Z'),
        currentKnowledgeVersionId: '6650f1a2c3d4e5f601020399',
        settings: { a: 1 },
        lifecycleStatusReasonCode: 'project_created',
        lifecycleStatusChangedAt: new Date('2026-09-11T09:12:04.000Z'),
        sourceConfig: {
          sourceType: 'repository',
          repositoryConnectionId: '6650f1a2c3d4e5f601020311',
          currentSourceVersionId: '6650f1a2c3d4e5f601020322',
        },
      },
      { detail: true },
    );
    expect(dto.archivedAt).toBe('2026-09-11T10:00:00.000Z');
    expect(dto.currentKnowledgeVersionId).toBe('6650f1a2c3d4e5f601020399');
    expect(dto.settings).toEqual({ a: 1 });
    expect(dto.sourceConfig.repositoryConnectionId).toBe('6650f1a2c3d4e5f601020311');
    expect(dto.sourceConfig.currentSourceVersionId).toBe('6650f1a2c3d4e5f601020322');
  });

  it('handles missing optional fields and string timestamps', () => {
    const dto = mapProjectToDto(
      {
        id: 'abc',
        name: 'X',
        lifecycleStatus: 'failed',
        knowledgeHealth: 'failed',
        sourceConfig: { sourceType: 'upload' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        archivedAt: '',
        lifecycleStatusChangedAt: '2026-01-03T00:00:00.000Z',
        settings: null,
      },
      { detail: true },
    );
    expect(dto.id).toBe('abc');
    expect(dto.description).toBe('');
    expect(dto.createdBy).toBeNull();
    expect(dto.counts.sourceVersions).toBe(0);
    expect(dto.archivedAt).toBeNull();
    expect(dto.settings).toEqual({});
    expect(dto.lifecycleStatusChangedAt).toBe('2026-01-03T00:00:00.000Z');
    expect(dto.currentKnowledgeVersionId).toBeNull();
  });
});
