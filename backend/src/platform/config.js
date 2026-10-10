/**
 * Application runtime configuration read from environment variables.
 * All `process.env` reads are centralised here — no scattered accesses elsewhere.
 */
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { parseEncryptionKey } from './secretCrypto.js';

const LOG_LEVELS = new Set(['debug', 'info', 'warning', 'error']);

/** Minimum length for JWT signing secrets (bytes of entropy guidance). */
export const JWT_ACCESS_TOKEN_SECRET_MIN_LENGTH = 32;

/** Default workspace root used only when NODE_ENV=test and WORKSPACE_ROOT is unset. */
const TEST_DEFAULT_WORKSPACE_ROOT = path.join(os.tmpdir(), 'codex-sage-workspace-test');

/** 32-byte test key used only when NODE_ENV=test and the env key is unset. */
const TEST_DEFAULT_REPO_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

/** Non-empty hostname (after trim). */
const hostSchema = z.string().trim().min(1, { error: 'must be a non-empty hostname' });

/** TCP port 1–65535; default applied before parse when env is absent. */
const portSchema = z.coerce
  .number()
  .int({ error: 'expected integer 1–65535' })
  .min(1, { error: 'expected integer 1–65535' })
  .max(65535, { error: 'expected integer 1–65535' });

/** Required MongoDB URI; never include the received value in error output. */
const mongoUriSchema = z.string().trim().min(1, { error: 'required MongoDB connection string (no default)' });

/** JWT signing secret; never include the received value in error output. */
const jwtSecretSchema = z.string().min(JWT_ACCESS_TOKEN_SECRET_MIN_LENGTH, {
  error: `must be at least ${JWT_ACCESS_TOKEN_SECRET_MIN_LENGTH} characters`,
});

/** Required OpenAI-compatible root; never include the received value in error output. */
const llmBaseUrlSchema = z
  .string()
  .trim()
  .min(1, { error: 'required http or https OpenAI-compatible base URL (no default)' })
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { error: 'must be an http or https URL' },
  );

/** Required model id already served at LLM_BASE_URL (exact `/v1/models` id). */
const llmModelIdSchema = z.string().trim().min(1, { error: 'required model id (no default)' });

/** Operational context window from env; must be a positive integer. */
const llmContextCapacitySchema = z.coerce.number().int({ error: 'expected a positive integer' }).positive({ error: 'expected a positive integer' });

/**
 * Reads the repository credential encryption key without requiring Mongo/JWT env.
 * @param {NodeJS.ProcessEnv} [env] Env overlay.
 * @returns {{ encryptionKey: Buffer, keyId: string }}
 */
export function resolveRepositoryCrypto(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const parsed = parseRepositoryCrypto(env, nodeEnv);
  if (parsed.error || !parsed.encryptionKey) {
    throw new Error(parsed.error ?? 'REPO_CREDENTIAL_ENCRYPTION_KEY: required 32-byte base64 value');
  }
  return { encryptionKey: parsed.encryptionKey, keyId: parsed.keyId };
}

/**
 * @param {NodeJS.ProcessEnv} env Env overlay.
 * @param {string} nodeEnv Resolved NODE_ENV.
 * @returns {{ encryptionKey: Buffer | null, keyId: string, error?: string }}
 */
function parseRepositoryCrypto(env, nodeEnv) {
  const rawKey = typeof env.REPO_CREDENTIAL_ENCRYPTION_KEY === 'string' ? env.REPO_CREDENTIAL_ENCRYPTION_KEY : '';
  const keyCandidate = rawKey.trim() || (nodeEnv === 'test' ? TEST_DEFAULT_REPO_ENCRYPTION_KEY_B64 : '');
  const keyIdRaw = typeof env.REPO_CREDENTIAL_KEY_ID === 'string' ? env.REPO_CREDENTIAL_KEY_ID.trim() : '';
  const keyId = keyIdRaw || 'k1';
  if (!keyCandidate) {
    return {
      encryptionKey: null,
      keyId,
      error: 'REPO_CREDENTIAL_ENCRYPTION_KEY: required 32-byte base64 value',
    };
  }
  try {
    return { encryptionKey: parseEncryptionKey(keyCandidate), keyId };
  } catch {
    return {
      encryptionKey: null,
      keyId,
      error: 'REPO_CREDENTIAL_ENCRYPTION_KEY: must be 32-byte base64',
    };
  }
}

/**
 * Parses `APP_RUNNING_PLATFORM` into a known platform value.
 * Unknown values fall back to standalone (the default for local runs).
 * @param {string | undefined} raw Raw env value.
 * @returns {'container' | 'standalone'}
 */
export function parseAppRunningPlatform(raw) {
  const value = (raw ?? 'standalone').trim().toLowerCase();
  return value === 'container' ? 'container' : 'standalone';
}

/**
 * Parses `LOG_LEVEL` into a supported level; unknown values fall back to `info`.
 * @param {string | undefined} raw Raw env value.
 * @returns {string} One of debug/info/warning/error.
 */
export function parseLogLevel(raw) {
  const value = (raw ?? 'info').trim().toLowerCase();
  return LOG_LEVELS.has(value) ? value : 'info';
}

/**
 * Parses and validates `API_PORT`.
 * @param {string | undefined} raw Raw env value.
 * @returns {number} A TCP port in the range 1–65535.
 * @throws {Error} When the value is not a valid port number.
 */
export function parsePort(raw) {
  const result = portSchema.safeParse(raw ?? '3000');
  if (!result.success) {
    throw new Error('API_PORT: expected integer 1–65535');
  }
  return result.data;
}

/**
 * Appends a field validation failure using a fixed message (never the raw value).
 * @param {string[]} errors Accumulator of `VARIABLE: message` lines.
 * @param {string} variable Env variable name.
 * @param {{ success: boolean, error?: { issues: Array<{ message?: string }> } }} result Zod result.
 */
function collectFieldError(errors, variable, result) {
  if (result.success) {
    return;
  }
  const message = result.error.issues[0]?.message ?? 'invalid';
  errors.push(`${variable}: ${message}`);
}

/**
 * Builds application configuration by reading environment variables.
 * Collects every validation error before throwing so operators see the full list.
 * Thrown messages name variables and expected formats but never include secret values.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] Env map; defaults to process.env.
 * @returns {object} Populated application configuration object.
 * @throws {Error} When one or more required values are missing or invalid.
 */
export function loadConfig(env = process.env) {
  const errors = [];
  const hostResult = hostSchema.safeParse(env.API_HOST ?? '0.0.0.0');
  collectFieldError(errors, 'API_HOST', hostResult);
  const portResult = portSchema.safeParse(env.API_PORT ?? '3000');
  collectFieldError(errors, 'API_PORT', portResult);
  const mongoResult = mongoUriSchema.safeParse(env.MONGODB_URI ?? '');
  collectFieldError(errors, 'MONGODB_URI', mongoResult);
  const jwtResult = jwtSecretSchema.safeParse(env.JWT_ACCESS_TOKEN_SECRET ?? '');
  collectFieldError(errors, 'JWT_ACCESS_TOKEN_SECRET', jwtResult);
  const nodeEnv = env.NODE_ENV ?? 'development';
  const workspaceRoot = parseWorkspaceRoot(env, nodeEnv, errors);

  const crypto = parseRepositoryCrypto(env, nodeEnv);
  if (crypto.error) {
    errors.push(crypto.error);
  }
  const allowPrivateHosts = env.REPO_PROBE_ALLOW_PRIVATE_HOSTS === 'true';
  const llmBaseUrlResult = llmBaseUrlSchema.safeParse(env.LLM_BASE_URL ?? '');
  collectFieldError(errors, 'LLM_BASE_URL', llmBaseUrlResult);
  const llmModelIdResult = llmModelIdSchema.safeParse(env.LLM_MODEL_ID ?? '');
  collectFieldError(errors, 'LLM_MODEL_ID', llmModelIdResult);
  const llmCapacityResult = llmContextCapacitySchema.safeParse(env.LLM_CONTEXT_CAPACITY ?? '');
  collectFieldError(errors, 'LLM_CONTEXT_CAPACITY', llmCapacityResult);
  const llmApiKey = parseOptionalLlmApiKey(env.LLM_API_KEY);

  if (errors.length > 0) {
    throw new Error(`Invalid configuration:\n${errors.join('\n')}`);
  }
  return {
    env: {
      nodeEnv,
      isProduction: nodeEnv === 'production',
      isTest: nodeEnv === 'test',
      appRunningPlatform: parseAppRunningPlatform(env.APP_RUNNING_PLATFORM),
    },
    server: {
      host: hostResult.data,
      port: portResult.data,
    },
    logging: {
      level: parseLogLevel(env.LOG_LEVEL),
      logger: nodeEnv !== 'test',
      noConsoleLog: env.NO_CONSOLE_LOG === 'true',
    },
    mongo: {
      uri: mongoResult.data,
    },
    auth: {
      jwtAccessTokenSecret: jwtResult.data,
    },
    workspace: {
      root: workspaceRoot,
    },
    repositories: {
      encryptionKey: crypto.encryptionKey,
      keyId: crypto.keyId,
      allowPrivateHosts,
    },
    llm: {
      baseUrl: llmBaseUrlResult.data,
      modelId: llmModelIdResult.data,
      contextCapacity: llmCapacityResult.data,
      apiKey: llmApiKey,
    },
  };

  /**
   * Optional Bearer token. Empty or unset is null — never a dummy default.
   * @param {string | undefined} raw Env value.
   * @returns {string | null}
   */
  function parseOptionalLlmApiKey(raw) {
    if (typeof raw !== 'string') {
      return null;
    }
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }

  /**
   * Resolves WORKSPACE_ROOT: required absolute path outside tests; test may default to tmp.
   * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env Env map.
   * @param {string} nodeEnv Resolved NODE_ENV.
   * @param {string[]} errors Accumulator of validation errors.
   * @returns {string | null} Absolute workspace root, or null when invalid.
   */
  function parseWorkspaceRoot(env, nodeEnv, errors) {
    const raw = typeof env.WORKSPACE_ROOT === 'string' ? env.WORKSPACE_ROOT.trim() : '';
    const candidate = raw || (nodeEnv === 'test' ? TEST_DEFAULT_WORKSPACE_ROOT : '');
    if (!candidate) {
      errors.push('WORKSPACE_ROOT: required absolute path to the encrypted workspace volume');
      return null;
    }
    if (!path.isAbsolute(candidate)) {
      errors.push('WORKSPACE_ROOT: must be an absolute filesystem path');
      return null;
    }
    return path.resolve(candidate);
  }
}
