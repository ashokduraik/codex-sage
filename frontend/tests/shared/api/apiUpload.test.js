/**
 * Unit tests for the XHR upload helper.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/api/refreshClient.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, refreshAccessToken: vi.fn() };
});

import { apiUpload } from '@/shared/api/apiUpload.js';
import { API_BASE_URL } from '@/shared/api/apiConfig.js';
import { ApiError, RequestAbortedError } from '@/shared/api/ApiError.js';
import { refreshAccessToken, resetRefreshClientForTests } from '@/shared/api/refreshClient.js';
import { getAccessToken, setAccessToken, resetApiSessionForTests } from '@/shared/api/apiSession.js';

/**
 * @returns {{
 *   instances: object[],
 *   install: () => void,
 * }}
 */
function mockXhr() {
  const instances = [];
  class FakeXHR {
    constructor() {
      this.upload = {};
      this.status = 0;
      this.responseText = '';
      this.headers = {};
      this.sent = null;
      this.readyState = 0;
      instances.push(this);
    }

    /**
     * @param {string} method Method.
     * @param {string} url URL.
     */
    open(method, url) {
      this.method = method;
      this.url = url;
    }

    /**
     * @param {string} name Header name.
     * @param {string} value Header value.
     */
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }

    /**
     * @param {string} name Header name.
     * @returns {string | null}
     */
    getResponseHeader(name) {
      if (!this.responseHeaders) {
        return null;
      }
      const key = Object.keys(this.responseHeaders).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
      return key ? this.responseHeaders[key] : null;
    }

    /**
     * @param {unknown} body Body.
     */
    send(body) {
      this.sent = body;
    }

    abort() {
      this.onabort?.();
    }
  }
  return {
    instances,
    install() {
      vi.stubGlobal('XMLHttpRequest', FakeXHR);
    },
  };
}

describe('apiUpload', () => {
  beforeEach(() => {
    resetApiSessionForTests();
    resetRefreshClientForTests();
    refreshAccessToken.mockReset();
    vi.unstubAllGlobals();
  });

  it('sends FormData with Idempotency-Key and reports progress', async () => {
    setAccessToken('access-1');
    const xhrMock = mockXhr();
    xhrMock.install();
    const body = new FormData();
    body.append('archive', new File(['x'], 'a.zip'));
    const onUploadProgress = vi.fn();
    const pending = apiUpload('/projects/p1/sources', {
      body,
      idempotencyKey: 'idem-1',
      onUploadProgress,
    });
    const xhr = xhrMock.instances[0];
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(`${API_BASE_URL}/projects/p1/sources`);
    expect(xhr.headers.Authorization).toBe('Bearer access-1');
    expect(xhr.headers['Idempotency-Key']).toBe('idem-1');
    expect(xhr.headers['Content-Type']).toBeUndefined();
    xhr.responseHeaders = { 'X-Correlation-Id': 'ref-1' };
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 10, total: 20 });
    xhr.status = 202;
    xhr.responseText = JSON.stringify({ sourceVersionId: 'sv1', jobId: 'j1' });
    xhr.onload();
    await expect(pending).resolves.toEqual({ sourceVersionId: 'sv1', jobId: 'j1' });
    expect(onUploadProgress).toHaveBeenCalledWith({ loaded: 10, total: 20 });
  });

  it('maps envelope errors and network failures', async () => {
    const xhrMock = mockXhr();
    xhrMock.install();
    const pending = apiUpload('/projects/p1/sources', {
      body: new FormData(),
      idempotencyKey: 'idem-2',
    });
    const xhr = xhrMock.instances[0];
    xhr.status = 400;
    xhr.responseHeaders = { 'X-Correlation-Id': 'corr-err' };
    xhr.responseText = JSON.stringify({
      error: { code: 'SOURCE_ZIP_SLIP', message: 'Unsafe path', reference: 'corr-err' },
    });
    xhr.onload();
    await expect(pending).rejects.toMatchObject({
      code: 'SOURCE_ZIP_SLIP',
      message: 'Unsafe path',
      correlationId: 'corr-err',
    });

    const pendingNet = apiUpload('/projects/p1/sources', {
      body: new FormData(),
      idempotencyKey: 'idem-3',
    });
    xhrMock.instances[1].onerror();
    await expect(pendingNet).rejects.toBeInstanceOf(ApiError);

    const pendingAbort = apiUpload('/projects/p1/sources', {
      body: new FormData(),
      idempotencyKey: 'idem-4',
    });
    xhrMock.instances[2].onabort();
    await expect(pendingAbort).rejects.toBeInstanceOf(RequestAbortedError);
  });

  it('joins a path without a leading slash and accepts extra headers', async () => {
    const xhrMock = mockXhr();
    xhrMock.install();
    const pending = apiUpload('projects/p1/sources', {
      body: new FormData(),
      method: 'PUT',
      headers: { 'X-Extra': 'yes' },
    });
    const xhr = xhrMock.instances[0];
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe(`${API_BASE_URL}/projects/p1/sources`);
    expect(xhr.headers['X-Extra']).toBe('yes');
    xhr.status = 204;
    xhr.responseText = '';
    xhr.onload();
    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects an already-aborted signal and ignores non-computable progress', async () => {
    const xhrMock = mockXhr();
    xhrMock.install();
    await expect(
      apiUpload('/projects/p1/sources', {
        body: new FormData(),
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(RequestAbortedError);

    const onUploadProgress = vi.fn();
    const controller = new AbortController();
    const pending = apiUpload('/projects/p1/sources', {
      body: new FormData(),
      signal: controller.signal,
      onUploadProgress,
    });
    xhrMock.instances[0].upload.onprogress?.({
      lengthComputable: false,
      loaded: 1,
      total: 2,
    });
    expect(onUploadProgress).not.toHaveBeenCalled();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(RequestAbortedError);
  });

  it('retries once after 401 refresh and then returns the body', async () => {
    refreshAccessToken.mockResolvedValue('fresh');
    const xhrMock = mockXhr();
    xhrMock.install();
    const pending = apiUpload('/projects/p1/sources', {
      body: new FormData(),
      idempotencyKey: 'idem-r',
    });
    const first = xhrMock.instances[0];
    first.status = 401;
    first.responseText = JSON.stringify({
      error: { code: 'UNAUTHENTICATED', message: 'expired' },
    });
    first.onload();
    await vi.waitFor(() => expect(xhrMock.instances.length).toBe(2));
    const second = xhrMock.instances[1];
    second.status = 202;
    second.responseText = JSON.stringify({ ok: true });
    second.onload();
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('rethrows abort from refresh and original ApiError when refresh fails', async () => {
    refreshAccessToken.mockRejectedValueOnce(new RequestAbortedError());
    const xhrMock = mockXhr();
    xhrMock.install();
    const pendingAbort = apiUpload('/projects/p1/sources', { body: new FormData() });
    xhrMock.instances[0].status = 401;
    xhrMock.instances[0].onload();
    await expect(pendingAbort).rejects.toBeInstanceOf(RequestAbortedError);

    refreshAccessToken.mockRejectedValueOnce(new ApiError({ status: 401, code: 'SESSION_EXPIRED', message: 'gone' }));
    const pendingFail = apiUpload('/projects/p1/sources', { body: new FormData() });
    const failXhr = xhrMock.instances[1];
    failXhr.status = 401;
    failXhr.responseText = JSON.stringify({
      error: { code: 'UNAUTHENTICATED', message: 'expired' },
    });
    failXhr.onload();
    await expect(pendingFail).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('clears the session when the retried upload is still 401', async () => {
    setAccessToken('stale');
    refreshAccessToken.mockResolvedValue('fresh');
    const xhrMock = mockXhr();
    xhrMock.install();
    const pending = apiUpload('/projects/p1/sources', { body: new FormData() });
    xhrMock.instances[0].status = 401;
    xhrMock.instances[0].onload();
    await vi.waitFor(() => expect(xhrMock.instances.length).toBe(2));
    xhrMock.instances[1].status = 401;
    xhrMock.instances[1].responseText = JSON.stringify({
      error: { code: 'FORBIDDEN', message: 'nope' },
    });
    xhrMock.instances[1].onload();
    await expect(pending).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getAccessToken()).toBeNull();
  });

  it('skips refresh, treats empty 200 as undefined, and rejects invalid JSON', async () => {
    const xhrMock = mockXhr();
    xhrMock.install();
    const skipped = apiUpload('/projects/p1/sources', {
      body: new FormData(),
      skipAuthRefresh: true,
    });
    xhrMock.instances[0].status = 401;
    xhrMock.instances[0].responseText = JSON.stringify({
      error: { code: 'INVALID_CREDENTIALS', message: 'bad' },
    });
    xhrMock.instances[0].onload();
    await expect(skipped).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(refreshAccessToken).not.toHaveBeenCalled();

    const empty = apiUpload('/projects/p1/sources', { body: new FormData() });
    xhrMock.instances[1].status = 200;
    xhrMock.instances[1].responseText = '';
    xhrMock.instances[1].onload();
    await expect(empty).resolves.toBeUndefined();

    const invalid = apiUpload('/projects/p1/sources', { body: new FormData() });
    xhrMock.instances[2].status = 200;
    xhrMock.instances[2].responseText = 'not-json';
    xhrMock.instances[2].onload();
    await expect(invalid).rejects.toMatchObject({ code: 'UNEXPECTED' });
  });
});
