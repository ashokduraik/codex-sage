/**
 * Unit tests for tenant-safe workspace path resolution.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPathInsideRoot,
  resolveProjectWorkspacePath,
  resolveSafeWorkspaceFilePath,
} from '../../../src/modules/knowledge/sources.js';

const ROOT = path.join(os.tmpdir(), 'codex-sage-ws-paths-test');

describe('resolveProjectWorkspacePath', () => {
  it('joins org and project under the workspace root', () => {
    const result = resolveProjectWorkspacePath(ROOT, 'org1', 'proj1');
    expect(result).toBe(path.resolve(ROOT, 'org1', 'proj1'));
  });

  it('rejects relative WORKSPACE_ROOT', () => {
    expect(() => resolveProjectWorkspacePath('relative/root', 'org1', 'proj1')).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_ROOT_INVALID' }),
    );
  });

  it('rejects ids that contain path separators or ..', () => {
    expect(() => resolveProjectWorkspacePath(ROOT, '../../../src/modules/x', 'proj1')).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_PATH_UNSAFE' }),
    );
    expect(() => resolveProjectWorkspacePath(ROOT, 'org1', 'a/b')).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_PATH_UNSAFE' }),
    );
  });
});

describe('resolveSafeWorkspaceFilePath', () => {
  const workspacePath = path.join(ROOT, 'org1', 'proj1');

  it('resolves a normalized relative path under the project workspace', () => {
    expect(resolveSafeWorkspaceFilePath(workspacePath, 'docs/readme.md')).toBe(
      path.resolve(workspacePath, 'docs', 'readme.md'),
    );
  });

  it('rejects .. segments, absolute paths, and escapes outside the workspace', () => {
    expect(() => resolveSafeWorkspaceFilePath(workspacePath, '../../../src/modules/secret')).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_PATH_UNSAFE' }),
    );
    expect(() => resolveSafeWorkspaceFilePath(workspacePath, '/etc/passwd')).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_PATH_UNSAFE' }),
    );
    expect(() => resolveSafeWorkspaceFilePath(workspacePath, 'a/../../outside')).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_PATH_UNSAFE' }),
    );
  });
});

describe('assertPathInsideRoot', () => {
  it('allows the root itself and nested paths', () => {
    expect(() => assertPathInsideRoot(ROOT, ROOT)).not.toThrow();
    expect(() => assertPathInsideRoot(ROOT, path.join(ROOT, 'a'))).not.toThrow();
  });

  it('rejects paths outside the root', () => {
    expect(() => assertPathInsideRoot(ROOT, path.join(ROOT, '..', 'other'))).toThrow(
      expect.objectContaining({ code: 'WORKSPACE_PATH_UNSAFE' }),
    );
  });
});
