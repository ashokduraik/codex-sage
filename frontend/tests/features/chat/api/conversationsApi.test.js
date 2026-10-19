/**
 * conversationsApi request builders.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getConversation,
  listConversations,
  createConversation,
  deleteConversation,
  renameConversation,
  archiveConversation,
  restoreConversation,
  searchConversations,
  listConversationMessages,
} from '@/features/chat/api/conversationsApi.js';

const apiRequest = vi.fn();

vi.mock('@/shared/api/index', () => ({
  apiRequest: (...args) => apiRequest(...args),
}));

describe('conversationsApi', () => {
  afterEach(() => {
    apiRequest.mockReset();
  });

  it('lists with archived flag, cursor, and default limit', async () => {
    apiRequest.mockResolvedValue({ items: [], nextCursor: null });
    await listConversations('prj_1', { archived: true, cursor: 'c1' });
    const path = apiRequest.mock.calls[0][0];
    expect(path).toMatch(/^\/conversation\/conversation\/list\/prj_1\?/);
    expect(path).toContain('archived=true');
    expect(path).toContain('cursor=c1');
    expect(path).toContain('limit=20');
  });

  it('searches with q and encodes project id', async () => {
    apiRequest.mockResolvedValue({ items: [], nextCursor: null });
    await searchConversations('prj/a', { q: 'auth', archived: false });
    const path = apiRequest.mock.calls[0][0];
    expect(path).toContain('/conversation/conversation/search/prj%2Fa');
    expect(path).toContain('q=auth');
    expect(path).not.toContain('archived=');
  });

  it('gets detail and lists messages', async () => {
    apiRequest.mockResolvedValue({ id: 'c1' });
    await getConversation('p1', 'c1');
    expect(apiRequest).toHaveBeenCalledWith('/conversation/conversation/get/p1/c1', {
      signal: undefined,
    });

    apiRequest.mockResolvedValue({ items: [], nextCursor: null });
    await listConversationMessages('p1', 'c1', { cursor: 'm1' });
    const path = apiRequest.mock.calls[1][0];
    expect(path).toContain('/conversation/conversation/listMessages/p1/c1');
    expect(path).toContain('cursor=m1');
    expect(path).toContain('limit=50');
  });

  it('creates with Idempotency-Key and maps lifecycle verbs', async () => {
    apiRequest.mockResolvedValue({ id: 'c1', title: 'New conversation' });
    await createConversation('p1', { idempotencyKey: 'idem-1' });
    expect(apiRequest).toHaveBeenCalledWith('/conversation/conversation/create', {
      method: 'POST',
      body: { projectId: 'p1' },
      idempotencyKey: 'idem-1',
    });

    await createConversation('p1', { title: 'Auth', idempotencyKey: 'idem-2' });
    expect(apiRequest).toHaveBeenCalledWith('/conversation/conversation/create', {
      method: 'POST',
      body: { projectId: 'p1', title: 'Auth' },
      idempotencyKey: 'idem-2',
    });

    await renameConversation('p1', 'c1', { title: 'Renamed' });
    expect(apiRequest).toHaveBeenCalledWith('/conversation/conversation/rename', {
      method: 'PATCH',
      body: { projectId: 'p1', conversationId: 'c1', title: 'Renamed' },
    });

    await archiveConversation('p1', 'c1');
    expect(apiRequest).toHaveBeenCalledWith('/conversation/conversation/archive', {
      method: 'POST',
      body: { projectId: 'p1', conversationId: 'c1' },
    });

    await restoreConversation('p1', 'c1');
    expect(apiRequest).toHaveBeenCalledWith('/conversation/conversation/restore', {
      method: 'POST',
      body: { projectId: 'p1', conversationId: 'c1' },
    });

    await deleteConversation('p1', 'c1');
    expect(apiRequest).toHaveBeenCalledWith('/conversation/conversation/delete', {
      method: 'DELETE',
      body: { projectId: 'p1', conversationId: 'c1' },
    });
  });
});
