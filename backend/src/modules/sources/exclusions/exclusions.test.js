/**
 * Unit tests for summarizeInspection and ruleset assert helper.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../platform/errors.js';
import {
  EXCLUSION_RULESET_ID,
  GRAPH_FILE_MAX_BYTES,
  assertKnownExclusionRulesetId,
  inspectZip,
  summarizeInspection,
} from './index.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('summarizeInspection', () => {
  it('accepts source and skips ignored paths from a fixture zip', async () => {
    const { entries } = await inspectZip(await readFile(path.join(fixturesDir, 'good.zip')));
    const summary = summarizeInspection(entries);
    expect(summary.rulesetId).toBe(EXCLUSION_RULESET_ID);
    expect(summary.emptyAfterExclude).toBe(false);
    expect(summary.accepted.map((item) => item.path).sort()).toEqual(['README.md', 'src/a.js']);
    expect(summary.accepted.every((item) => item.excludedFromGraph === false)).toBe(true);
    const skippedReasons = Object.fromEntries(
      summary.skipped.map((item) => [item.path, item.reasonCode]),
    );
    expect(skippedReasons['node_modules/pkg/index.js']).toBe('ignored_directory');
    expect(skippedReasons['.git/HEAD']).toBe('ignored_directory');
    expect(skippedReasons['photo.png']).toBe('ignored_image');
    expect(skippedReasons['icon.svg']).toBe('ignored_image');
    expect(skippedReasons['dist/app.js']).toBe('ignored_directory');
  });

  it('marks oversized allowlisted files as excludedFromGraph', () => {
    const summary = summarizeInspection([
      { path: 'src/a.js', uncompressedSize: 10 },
      { path: 'huge.ts', uncompressedSize: GRAPH_FILE_MAX_BYTES + 1 },
    ]);
    expect(summary.accepted).toEqual([
      { path: 'src/a.js', size: 10, excludedFromGraph: false },
      {
        path: 'huge.ts',
        size: GRAPH_FILE_MAX_BYTES + 1,
        excludedFromGraph: true,
        exclusionReason: 'file_too_large',
      },
    ]);
  });

  it('throws SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS when only ignored paths remain', async () => {
    const { entries } = await inspectZip(
      await readFile(path.join(fixturesDir, 'only-ignored.zip')),
    );
    expect(() => summarizeInspection(entries)).toThrow(ApiError);
    try {
      summarizeInspection(entries);
    } catch (error) {
      expect(/** @type {ApiError} */ (error).code).toBe(
        'SOURCE_VERSION_EMPTY_AFTER_EXCLUSIONS',
      );
    }
  });

  it('throws for an empty zip entry list', () => {
    expect(() => summarizeInspection([])).toThrow(ApiError);
  });

  it('uses stable fallback reason codes when decision helpers omit them', () => {
    const summary = summarizeInspection([
      { path: 'src/a.js', uncompressedSize: 1 },
      { path: 'huge.ts', uncompressedSize: GRAPH_FILE_MAX_BYTES + 1 },
    ]);
    const huge = summary.accepted.find((item) => item.path === 'huge.ts');
    expect(huge?.exclusionReason).toBe('file_too_large');
  });

  it('throws for images-only archives after inspection', async () => {
    const { entries } = await inspectZip(
      await readFile(path.join(fixturesDir, 'images-only.zip')),
    );
    expect(() => summarizeInspection(entries)).toThrow(ApiError);
  });
});

describe('assertKnownExclusionRulesetId', () => {
  it('accepts the current ruleset id', () => {
    expect(() => assertKnownExclusionRulesetId(EXCLUSION_RULESET_ID)).not.toThrow();
  });

  it('fails permanent for an unknown ruleset id', () => {
    try {
      assertKnownExclusionRulesetId('exclusions.v0');
      expect.unreachable('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(/** @type {ApiError} */ (error).code).toBe('SOURCE_UNKNOWN_EXCLUSION_RULESET');
    }
  });
});
