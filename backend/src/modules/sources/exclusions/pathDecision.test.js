/**
 * Unit tests for per-entry upload path decisions.
 */
import { describe, expect, it } from 'vitest';
import { GRAPH_FILE_MAX_BYTES } from './exclusions.constants.js';
import { evaluateUploadEntry } from './pathDecision.js';

describe('evaluateUploadEntry', () => {
  it('accepts allowlisted source under the graph size cap', () => {
    expect(evaluateUploadEntry({ path: 'src/a.js', uncompressedSize: 1200 })).toEqual({
      decision: 'accept',
    });
  });

  it('skips ignored directories including nested prefixes', () => {
    expect(
      evaluateUploadEntry({ path: 'node_modules/pkg/index.js', uncompressedSize: 10 }),
    ).toEqual({ decision: 'skip', reasonCode: 'ignored_directory' });
    expect(evaluateUploadEntry({ path: '.git/HEAD', uncompressedSize: 10 })).toEqual({
      decision: 'skip',
      reasonCode: 'ignored_directory',
    });
    expect(evaluateUploadEntry({ path: 'dist/bundle.js', uncompressedSize: 10 })).toEqual({
      decision: 'skip',
      reasonCode: 'ignored_directory',
    });
  });

  it('skips images including svg', () => {
    expect(evaluateUploadEntry({ path: 'photo.png', uncompressedSize: 10 })).toEqual({
      decision: 'skip',
      reasonCode: 'ignored_image',
    });
    expect(evaluateUploadEntry({ path: 'icon.svg', uncompressedSize: 10 })).toEqual({
      decision: 'skip',
      reasonCode: 'ignored_image',
    });
  });

  it('skips junk basenames and minified assets', () => {
    expect(evaluateUploadEntry({ path: 'src/.DS_Store', uncompressedSize: 1 })).toEqual({
      decision: 'skip',
      reasonCode: 'ignored_file',
    });
    expect(evaluateUploadEntry({ path: 'vendor/app.min.js', uncompressedSize: 10 })).toEqual({
      decision: 'skip',
      reasonCode: 'ignored_file',
    });
  });

  it('skips unsupported extensions', () => {
    expect(evaluateUploadEntry({ path: 'bin/tool.exe', uncompressedSize: 10 })).toEqual({
      decision: 'skip',
      reasonCode: 'unsupported_extension',
    });
  });

  it('marks files over 1 MiB as accept_excluded_from_graph', () => {
    expect(
      evaluateUploadEntry({
        path: 'huge.ts',
        uncompressedSize: GRAPH_FILE_MAX_BYTES + 1,
      }),
    ).toEqual({
      decision: 'accept_excluded_from_graph',
      reasonCode: 'file_too_large',
    });
  });

  it('accepts docs and allowlisted config basenames', () => {
    expect(evaluateUploadEntry({ path: 'docs/a.md', uncompressedSize: 20 })).toEqual({
      decision: 'accept',
    });
    expect(evaluateUploadEntry({ path: 'package.json', uncompressedSize: 20 })).toEqual({
      decision: 'accept',
    });
    expect(evaluateUploadEntry({ path: '.eslintrc.cjs', uncompressedSize: 20 })).toEqual({
      decision: 'accept',
    });
    expect(evaluateUploadEntry({ path: '.env.example', uncompressedSize: 20 })).toEqual({
      decision: 'accept',
    });
  });

  it('normalizes backslashes before deciding', () => {
    expect(evaluateUploadEntry({ path: 'src\\a.ts', uncompressedSize: 20 })).toEqual({
      decision: 'accept',
    });
  });
});
