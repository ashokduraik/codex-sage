/**
 * Conversation DTO mapping unit tests.
 */
import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  mapConversationToDto,
  mapConversationToListDto,
  mapConversationToSearchDto,
  mapMessageToDto,
} from './conversations.service.js';

describe('conversations.types', () => {
  it('maps detail, list, and search shapes', () => {
    const conversation = {
      _id: new mongoose.Types.ObjectId(),
      projectId: new mongoose.Types.ObjectId(),
      ownerUserId: new mongoose.Types.ObjectId(),
      title: 'Checkout',
      titleSource: 'user',
      lifecycleStatus: 'active',
      messageCount: 2,
      lastMessageAt: new Date('2026-09-12T10:00:00.000Z'),
      archivedAt: null,
      createdAt: new Date('2026-09-12T09:00:00.000Z'),
      updatedAt: new Date('2026-09-12T10:00:00.000Z'),
    };
    const detail = mapConversationToDto(conversation);
    expect(detail.ownerUserId).toBe(String(conversation.ownerUserId));
    expect(detail.archivedAt).toBeNull();
    expect(detail.lastMessageAt).toBe('2026-09-12T10:00:00.000Z');

    const list = mapConversationToListDto(conversation);
    expect(list.ownerUserId).toBeUndefined();
    expect(list.id).toBe(String(conversation._id));

    const search = mapConversationToSearchDto(conversation, 'snippet');
    expect(search.snippet).toBe('snippet');
    expect(search.titleSource).toBe('user');
  });

  it('omits null reserved message fields and includes them when present', () => {
    const base = {
      id: new mongoose.Types.ObjectId(),
      role: 'user',
      content: 'hello',
      messageStatus: 'completed',
      createdAt: new Date('2026-09-12T10:01:00.000Z'),
    };
    const plain = mapMessageToDto(base);
    expect(plain.evidence).toBeUndefined();
    expect(plain.usage).toBeUndefined();
    expect(plain.contextMetrics).toBeUndefined();

    const rich = mapMessageToDto({
      ...base,
      evidence: [{ path: 'a.js' }],
      usage: { tokens: 1 },
      contextMetrics: { used: 10 },
    });
    expect(rich.evidence).toEqual([{ path: 'a.js' }]);
    expect(rich.usage).toEqual({ tokens: 1 });
    expect(rich.contextMetrics).toEqual({ used: 10 });
  });

  it('stringifies non-date timestamps', () => {
    const dto = mapConversationToDto({
      id: 'c1',
      projectId: 'p1',
      ownerUserId: 'u1',
      title: 'T',
      titleSource: 'default',
      lifecycleStatus: 'active',
      createdAt: 'stamp',
      updatedAt: undefined,
    });
    expect(dto.createdAt).toBe('stamp');
    expect(dto.updatedAt).toBe('');
    expect(dto.lastMessageAt).toBeNull();
    expect(
      mapConversationToDto({
        ...{
          id: 'c1',
          projectId: 'p1',
          ownerUserId: 'u1',
          title: 'T',
          titleSource: 'default',
          lifecycleStatus: 'active',
          createdAt: 'stamp',
          updatedAt: 'stamp',
          lastMessageAt: '2026-09-12T10:00:00.000Z',
        },
      }).lastMessageAt,
    ).toBe('2026-09-12T10:00:00.000Z');
  });
});
