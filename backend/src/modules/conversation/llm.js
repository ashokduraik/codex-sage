/**
 * OpenAI-compatible reachability probe for API startup. Confirms GET /models
 * lists the configured model id, then returns that id as the artifact id.
 * No generate, no pull.
 */

/** Fail the probe if the provider does not answer within this window. */
export const LLM_PROBE_TIMEOUT_MS = 10_000;

const defaultLog = {
  info: (obj, msg) => console.info(JSON.stringify({ level: 'info', msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: 'error', msg, ...obj })),
};

/**
 * Host only — never the raw env URL (it may include credentials).
 * @param {string} baseUrl Configured OpenAI-compatible root.
 * @returns {string}
 */
function describeLlmHost(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '(unparseable)';
  }
}

/**
 * Joins a relative path onto the OpenAI-compatible root. Trailing slash is
 * required so `…/v1` + `models` stays `…/v1/models`.
 * @param {string} baseUrl Configured root (typically ends in `/v1`).
 * @param {string} relativePath Path such as `models`.
 * @returns {string}
 */
function llmApiUrl(baseUrl, relativePath) {
  const root = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(relativePath, root).href;
}

/**
 * Fetches JSON from the provider with the probe timeout. Does not log the URL.
 * @param {string} url Absolute request URL.
 * @param {RequestInit} [options] Fetch options.
 * @returns {Promise<{ ok: boolean, status: number, body: object | null }>}
 */
async function fetchLlmJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(LLM_PROBE_TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

/**
 * Builds probe headers. Bearer is sent only when an API key is configured.
 * @param {string | null | undefined} apiKey Optional Bearer token.
 * @returns {Record<string, string>}
 */
function buildProbeHeaders(apiKey) {
  const headers = { accept: 'application/json' };
  if (typeof apiKey === 'string' && apiKey !== '') {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * Proves the OpenAI-compatible host is up and the configured model id is listed.
 * @param {{ baseUrl: string, modelId: string, apiKey?: string | null }} llm Env-backed connection slice.
 * @param {{ info: Function, error: Function }} [log] Structured logger.
 * @returns {Promise<{ artifactId: string }>}
 * @throws {Error} When the host is down or the model id is missing from GET /models.
 */
export async function assertLlmAvailable(llm, log = defaultLog) {
  const host = describeLlmHost(llm.baseUrl);
  const modelId = llm.modelId;
  try {
    const listed = await fetchLlmJson(llmApiUrl(llm.baseUrl, 'models'), {
      headers: buildProbeHeaders(llm.apiKey),
    });
    if (!listed.ok) {
      throw new Error(`GET /models returned HTTP ${listed.status}`);
    }
    const models = Array.isArray(listed.body?.data) ? listed.body.data : [];
    const match = models.find((entry) => entry.id === modelId);
    if (!match) {
      throw new Error('model is not in GET /models');
    }

    log.info({ host, modelId }, 'llm available');
    return { artifactId: modelId };
  } catch (error) {
    const errName = error instanceof Error ? error.name : 'Error';
    log.error({ host, modelId, errName }, 'llm probe failed');
    throw error;
  }
}
