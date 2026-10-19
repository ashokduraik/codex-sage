/**
 * clarificationsApi answer POST + SSE resume.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerClarificationStream, CLARIFICATION_FREE_TEXT_MAX_LENGTH } from '@/features/chat/api/clarificationsApi.js';

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

describe('clarificationsApi', () => {
  it('exports the free-text max matching the backend constant', () => {
    expect(CLARIFICATION_FREE_TEXT_MAX_LENGTH).toBe(2000);
  });

  it('POSTs answers with Accept event-stream and returns done', async () => {
    const body = 'event: done\ndata: {"messageId":"msg_1"}\n\n';
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/event-stream' }),
      body: stream,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await answerClarificationStream({
      projectId: 'p1',
      conversationId: 'c1',
      messageId: 'msg_1',
      clarificationSetId: 'clr_1',
      answers: { q1: 'Production' },
      idempotencyKey: 'idem-1',
    });

    expect(result.terminal).toBe('done');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/conversation\/clarification\/answer$/);
    expect(init.headers.Accept).toBe('text/event-stream');
    expect(init.headers['Idempotency-Key']).toBe('idem-1');
    expect(JSON.parse(init.body)).toEqual({
      projectId: 'p1',
      conversationId: 'c1',
      messageId: 'msg_1',
      clarificationSetId: 'clr_1',
      answers: { q1: 'Production' },
    });
  });

  it('surfaces 409 CLARIFICATION_NOT_OPEN before the stream opens', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        headers: new Headers({ 'X-Correlation-Id': 'REQ-9' }),
        json: async () => ({
          error: {
            code: 'CLARIFICATION_NOT_OPEN',
            message: 'Clarification is not open',
            class: 'user',
            retryability: 'user_action_required',
            reference: 'REQ-9',
          },
        }),
      }),
    );

    await expect(
      answerClarificationStream({
        projectId: 'p1',
        conversationId: 'c1',
        messageId: 'msg_1',
        clarificationSetId: 'clr_1',
        answers: { q1: 'Production' },
        idempotencyKey: 'idem-1',
      }),
    ).rejects.toMatchObject({ code: 'CLARIFICATION_NOT_OPEN', status: 409 });
  });

  it('surfaces 400 validation errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        headers: new Headers(),
        json: async () => ({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid answers',
            class: 'user',
            retryability: 'user_action_required',
            reference: 'REQ-2',
          },
        }),
      }),
    );

    await expect(
      answerClarificationStream({
        projectId: 'p1',
        conversationId: 'c1',
        messageId: 'msg_1',
        clarificationSetId: 'clr_1',
        answers: { q1: '' },
        idempotencyKey: 'idem-1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });
  });
});
