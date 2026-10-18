/**
 * fillProjectDescriptionFromReadme — README load, LLM blurb, overwrite description.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fillProjectDescriptionFromReadme } from '../../../src/modules/masters/projects.js';

const findProjectById = vi.fn();
const updateProjectMetadata = vi.fn();
const recordAuditEvent = vi.fn();
const listSourceFilesOrdered = vi.fn();
const findSourceFileByPath = vi.fn();
const readSourceGridFsBytes = vi.fn();
const generateTextWithoutBudget = vi.fn();

vi.mock('../../../src/modules/access/index.js', () => ({
  buildAuditContextFromRequest: () => ({
    correlationId: 'corr',
    ip: '127.0.0.1',
    userAgent: 'test',
  }),
  recordAuditEvent: (...args) => recordAuditEvent(...args),
}));

vi.mock('../../../src/modules/masters/projects.helper.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findProjectById: (...args) => findProjectById(...args),
    updateProjectMetadata: (...args) => updateProjectMetadata(...args),
  };
});

vi.mock('../../../src/modules/knowledge/index.js', () => ({
  listSourceFilesOrdered: (...args) => listSourceFilesOrdered(...args),
  findSourceFileByPath: (...args) => findSourceFileByPath(...args),
  readSourceGridFsBytes: (...args) => readSourceGridFsBytes(...args),
}));

vi.mock('../../../src/modules/conversation/index.js', () => ({
  generateTextWithoutBudget: (...args) => generateTextWithoutBudget(...args),
}));

describe('fillProjectDescriptionFromReadme', () => {
  beforeEach(() => {
    findProjectById.mockReset();
    updateProjectMetadata.mockReset();
    recordAuditEvent.mockReset();
    listSourceFilesOrdered.mockReset();
    findSourceFileByPath.mockReset();
    readSourceGridFsBytes.mockReset();
    generateTextWithoutBudget.mockReset();
    recordAuditEvent.mockResolvedValue(undefined);
  });

  it('overwrites description from root README via the LLM', async () => {
    findProjectById.mockResolvedValue({
      _id: 'p1',
      name: 'Atlas',
      description: 'old',
      sourceConfig: { currentSourceVersionId: 'v1', sourceType: 'upload' },
      counts: {},
    });
    listSourceFilesOrdered.mockResolvedValue([{ path: 'readme.md' }, { path: 'src/a.js' }]);
    findSourceFileByPath.mockResolvedValue({ gridFsId: 'gfs1', path: 'readme.md' });
    readSourceGridFsBytes.mockResolvedValue(Buffer.from('# Title\n\nPayments service.\n'));
    generateTextWithoutBudget.mockResolvedValue({ text: '  A payments service.  ' });
    updateProjectMetadata.mockResolvedValue({
      _id: 'p1',
      name: 'Atlas',
      description: 'A payments service.',
      sourceConfig: { currentSourceVersionId: 'v1', sourceType: 'upload' },
      counts: {},
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
    });

    const dto = await fillProjectDescriptionFromReadme({
      orgId: 'o1',
      actorUserId: 'u1',
      projectId: 'p1',
      correlationId: 'corr',
    });

    expect(generateTextWithoutBudget).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: 'project_description',
        instructions: expect.stringContaining('1–2 plain sentences'),
        messages: [{ role: 'user', content: expect.stringContaining('Payments service') }],
      }),
    );
    expect(updateProjectMetadata).toHaveBeenCalledWith('o1', 'p1', {
      description: 'A payments service.',
      updatedBy: 'u1',
    });
    expect(dto.description).toBe('A payments service.');
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.description_filled_from_readme' }), expect.anything());
  });

  it('prefers exact README.md among root readme casings', async () => {
    findProjectById.mockResolvedValue({
      _id: 'p1',
      name: 'Atlas',
      description: '',
      sourceConfig: { currentSourceVersionId: 'v1', sourceType: 'upload' },
      counts: {},
    });
    listSourceFilesOrdered.mockResolvedValue([{ path: 'Readme.md' }, { path: 'README.md' }]);
    findSourceFileByPath.mockResolvedValue({ gridFsId: 'gfs1', path: 'README.md' });
    readSourceGridFsBytes.mockResolvedValue(Buffer.from('Hello world.\n'));
    generateTextWithoutBudget.mockResolvedValue({ text: 'Hello world project.' });
    updateProjectMetadata.mockResolvedValue({
      _id: 'p1',
      name: 'Atlas',
      description: 'Hello world project.',
      sourceConfig: { currentSourceVersionId: 'v1', sourceType: 'upload' },
      counts: {},
      lifecycleStatus: 'knowledge_ready',
      knowledgeHealth: 'ready',
    });

    await fillProjectDescriptionFromReadme({
      orgId: 'o1',
      actorUserId: 'u1',
      projectId: 'p1',
      correlationId: 'corr',
    });

    expect(findSourceFileByPath).toHaveBeenCalledWith(expect.objectContaining({ path: 'README.md' }));
  });

  it('returns SOURCE_VERSION_NOT_FOUND when no current source version', async () => {
    findProjectById.mockResolvedValue({
      _id: 'p1',
      name: 'Atlas',
      description: '',
      sourceConfig: { sourceType: 'upload' },
      counts: {},
    });

    await expect(
      fillProjectDescriptionFromReadme({
        orgId: 'o1',
        actorUserId: 'u1',
        projectId: 'p1',
        correlationId: 'corr',
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_VERSION_NOT_FOUND' });
    expect(generateTextWithoutBudget).not.toHaveBeenCalled();
  });

  it('returns SOURCE_NOT_FOUND when no root README exists', async () => {
    findProjectById.mockResolvedValue({
      _id: 'p1',
      name: 'Atlas',
      description: '',
      sourceConfig: { currentSourceVersionId: 'v1', sourceType: 'upload' },
      counts: {},
    });
    listSourceFilesOrdered.mockResolvedValue([{ path: 'docs/readme.md' }, { path: 'src/a.js' }]);

    await expect(
      fillProjectDescriptionFromReadme({
        orgId: 'o1',
        actorUserId: 'u1',
        projectId: 'p1',
        correlationId: 'corr',
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
    expect(generateTextWithoutBudget).not.toHaveBeenCalled();
  });

  it('returns VALIDATION_ERROR when README bytes are empty', async () => {
    findProjectById.mockResolvedValue({
      _id: 'p1',
      name: 'Atlas',
      description: '',
      sourceConfig: { currentSourceVersionId: 'v1', sourceType: 'upload' },
      counts: {},
    });
    listSourceFilesOrdered.mockResolvedValue([{ path: 'README.md' }]);
    findSourceFileByPath.mockResolvedValue({ gridFsId: 'gfs1', path: 'README.md' });
    readSourceGridFsBytes.mockResolvedValue(Buffer.from('   \n'));

    await expect(
      fillProjectDescriptionFromReadme({
        orgId: 'o1',
        actorUserId: 'u1',
        projectId: 'p1',
        correlationId: 'corr',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(generateTextWithoutBudget).not.toHaveBeenCalled();
  });
});
