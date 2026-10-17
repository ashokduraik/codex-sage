/**
 * chatStreamApi SSE parser and stage mapping unit tests.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSseParser, stageToI18nKey, streamConversationMessage } from '@/features/chat/api/chatStreamApi.js';

vi.mock('@/shared/api/apiConfig.js', () => ({
  API_BASE_URL: 'http://api.test/api/v1',
}));

vi.mock('@/shared/api/apiSession.js', () => ({
  getAccessToken: () => 'tok',
  clearSession: vi.fn(),
}));

vi.mock('@/shared/api/refreshClient.js', () => ({
  refreshAccessToken: vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('createSseParser', () => {
  it('parses multiple frames and ignores keepalives and unknown events at dispatch time', () => {
    const parser = createSseParser();
    const frames = parser.push('event: status\ndata: {"stage":"accepted"}\n\n: keepalive\n\nevent: delta\ndata: {"text":"Hi"}\n\n');
    expect(frames).toEqual([
      { event: 'status', data: { stage: 'accepted' } },
      { event: 'delta', data: { text: 'Hi' } },
    ]);
  });

  it('handles split chunks across reads', () => {
    const parser = createSseParser();
    expect(parser.push('event: delta\ndata: {"te')).toEqual([]);
    const rest = parser.push('xt":"ok"}\n\n');
    expect(rest).toEqual([{ event: 'delta', data: { text: 'ok' } }]);
  });
});

describe('stageToI18nKey', () => {
  it('maps known stages and falls back for unknown', () => {
    expect(stageToI18nKey('searching_code')).toBe('chat.stages.searchingCode');
    expect(stageToI18nKey('invented_stage')).toBe('chat.stages.working');
  });
});

describe('streamConversationMessage', () => {
  it('returns queued on 202 JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => ({ messageId: 'm1', messageStatus: 'queued' }),
      }),
    );
    const result = await streamConversationMessage({
      projectId: 'p1',
      conversationId: 'c1',
      content: 'hi',
      idempotencyKey: 'k1',
    });
    expect(result).toEqual({ kind: 'queued', body: { messageId: 'm1', messageStatus: 'queued' } });
  });

  it('parses SSE done and ignores unknown event types', async () => {
    const body = [
      'event: status\ndata: {"stage":"accepted"}\n\n',
      'event: mystery\ndata: {"x":1}\n\n',
      'event: delta\ndata: {"text":"A"}\n\n',
      'event: done\ndata: {"messageId":"m9"}\n\n',
    ].join('');
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const onEvent = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: stream,
      }),
    );
    const result = await streamConversationMessage({
      projectId: 'p1',
      conversationId: 'c1',
      content: 'hi',
      idempotencyKey: 'k1',
      onEvent,
    });
    expect(result.terminal).toBe('done');
    expect(result.messageId).toBe('m9');
    expect(onEvent.mock.calls.map((c) => c[0].event)).toEqual(['status', 'delta', 'done']);
  });

  it('marks interrupted when the stream ends without a terminal event', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"partial"}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        body: stream,
      }),
    );
    const result = await streamConversationMessage({
      projectId: 'p1',
      conversationId: 'c1',
      content: 'hi',
      idempotencyKey: 'k1',
    });
    expect(result.terminal).toBe('interrupted');
  });

  it('surfaces pre-stream HTTP errors as ApiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: new Headers({ 'X-Correlation-Id': 'REQ-1' }),
        json: async () => ({
          error: {
            code: 'KNOWLEDGE_UNAVAILABLE',
            message: 'Knowledge unavailable',
            class: 'knowledge',
            retryability: 'temporary',
            reference: 'REQ-1',
          },
        }),
      }),
    );
    await expect(
      streamConversationMessage({
        projectId: 'p1',
        conversationId: 'c1',
        content: 'hi',
        idempotencyKey: 'k1',
      }),
    ).rejects.toMatchObject({ code: 'KNOWLEDGE_UNAVAILABLE', status: 503 });
  });
});
