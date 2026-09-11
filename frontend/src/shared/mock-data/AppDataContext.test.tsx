import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppDataProvider, useAppData } from '@/shared/mock-data/AppDataContext';
import { seed } from '@/shared/mock-data/mockData';

/**
 * Wrapper that provides AppDataContext for hook tests.
 */
function wrapper({ children }: { children: ReactNode }) {
  return <AppDataProvider>{children}</AppDataProvider>;
}

describe('AppDataContext', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when useAppData is called outside AppDataProvider', () => {
    expect(() => renderHook(() => useAppData())).toThrow(/AppDataProvider/);
  });

  it('exposes seeded projects and org', () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    expect(result.current.org.name).toBe('Acme Corp');
    expect(result.current.projects.length).toBe(seed.projects.length);
  });

  it('creates a project', () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    let createdId = '';
    act(() => {
      const project = result.current.createProject({
        name: 'Nova',
        description: 'test',
        sourceType: 'upload',
      });
      createdId = project.id;
    });
    expect(result.current.getProject(createdId)?.name).toBe('Nova');
    expect(result.current.getProject(createdId)?.status).toBe('Awaiting source');
  });

  it('archives a project', () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    let createdId = '';
    act(() => {
      createdId = result.current.createProject({
        name: 'Archive Me',
        sourceType: 'repo',
      }).id;
      result.current.archiveProject(createdId, true);
    });
    expect(result.current.getProject(createdId)?.status).toBe('Archived');
  });

  it('creates a conversation and asks a question with streaming', async () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    let convId = '';
    act(() => {
      convId = result.current.createConversation('prj_atlas', 'New Chat').id;
    });

    await act(async () => {
      await result.current.askQuestion(convId, 'How does authentication work?');
    });

    const conversation = result.current.getConversation(convId);
    expect(conversation?.messages.some((message) => message.role === 'assistant')).toBe(true);
    expect(conversation?.title).not.toBe('New Chat');
    const assistant = conversation?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.content.length).toBeGreaterThan(0);
    expect(assistant?.status).toBe('Completed');
  });

  it('cancels askQuestion when the abort signal fires', async () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    let convId = '';
    act(() => {
      convId = result.current.createConversation('prj_atlas', 'Abort me').id;
    });

    const controller = new AbortController();
    const askPromise = act(async () => {
      const pending = result.current.askQuestion(convId, 'How does authentication work?', {
        signal: controller.signal,
      });
      controller.abort();
      await pending;
    });
    await askPromise;

    const conversation = result.current.getConversation(convId);
    const assistant = conversation?.messages.find((message) => message.role === 'assistant');
    expect(['Cancelled', 'Interrupted', 'Searching', 'Generating', 'Completed']).toContain(
      assistant?.status,
    );
  });

  it('attaches a repository and starts processing', () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    let projectId = '';
    act(() => {
      projectId = result.current.createProject({
        name: 'Repo Project',
        sourceType: 'repo',
      }).id;
      result.current.attachRepository(projectId, {
        fullName: 'acme/nova',
        provider: 'github',
        repoUrl: 'https://github.com/acme/nova',
        branch: 'main',
        origin: 'GitHub',
      });
    });
    const project = result.current.getProject(projectId);
    expect(project?.source.type).toBe('repo');
    expect(project?.status).toBe('Processing');
    expect(result.current.jobs.some((job) => job.projectId === projectId)).toBe(true);
  });

  it('adds an upload and renames or archives conversations', () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    let projectId = '';
    let convId = '';
    act(() => {
      projectId = result.current.createProject({
        name: 'Upload Project',
        sourceType: 'upload',
      }).id;
      result.current.addUpload(projectId, {
        name: 'src.zip',
        size: '1.2 MB',
        files: 12,
        uploadedAt: new Date().toISOString(),
        status: 'completed',
      });
      convId = result.current.createConversation(projectId, 'Temp').id;
      result.current.renameConversation(convId, 'Renamed');
      result.current.archiveConversation(convId, true);
    });
    expect(result.current.getProject(projectId)?.source.type).toBe('upload');
    expect(result.current.getConversation(convId)?.title).toBe('Renamed');
    expect(result.current.getConversation(convId)?.archived).toBe(true);
    act(() => {
      result.current.deleteConversation(convId);
    });
    expect(result.current.getConversation(convId)).toBeUndefined();
  });

  it('edits a user message and retries a job', () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    const seedJobId = result.current.jobs[0]?.id;
    expect(seedJobId).toBeTruthy();

    act(() => {
      result.current.editUserMessage('conv_1', 'm1', 'Updated auth question');
      if (seedJobId) result.current.retryJob(seedJobId);
    });

    const conversation = result.current.getConversation('conv_1');
    expect(
      conversation?.messages.some((message) => message.content === 'Updated auth question'),
    ).toBe(true);
    expect(result.current.jobs.find((job) => job.id === seedJobId)?.status).toBe(
      'in_progress',
    );
  });

  it('creates and soft-removes a user', () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    let userId = '';
    act(() => {
      userId = result.current.createUser({
        name: 'Ada',
        email: 'ada@acme.io',
        role: 'Editor',
      }).id;
    });
    expect(result.current.users.some((user) => user.id === userId)).toBe(true);
    act(() => {
      result.current.removeUser(userId);
    });
    expect(result.current.users.find((user) => user.id === userId)?.status).toBe('Inactive');
  });

  it('marks notifications as read', () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    const unread = result.current.notifications.find((notification) => !notification.read);
    expect(unread).toBeTruthy();
    act(() => {
      if (unread) result.current.markNotificationRead(unread.id);
      result.current.markAllNotificationsRead();
    });
    expect(result.current.notifications.every((notification) => notification.read)).toBe(true);
  });

  it('asks an unmatched question and abstains with stream callbacks', async () => {
    const onStatus = vi.fn();
    const onStream = vi.fn();
    const { result } = renderHook(() => useAppData(), { wrapper });
    let convId = '';
    act(() => {
      convId = result.current.createConversation('prj_atlas', 'New Chat').id;
    });

    await act(async () => {
      await result.current.askQuestion(convId, 'What is the meaning of life?', {
        onStatus,
        onStream,
      });
    });

    const conversation = result.current.getConversation(convId);
    const assistant = conversation?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.abstain).toBe(true);
    expect(onStatus).toHaveBeenCalled();
    expect(onStream).toHaveBeenCalled();
  });

  it('restores an archived project via archiveProject(false)', () => {
    const { result } = renderHook(() => useAppData(), { wrapper });
    let createdId = '';
    act(() => {
      createdId = result.current.createProject({
        name: 'Restore Me',
        sourceType: 'upload',
      }).id;
      result.current.archiveProject(createdId, true);
      result.current.archiveProject(createdId, false);
    });
    expect(result.current.getProject(createdId)?.status).toBe('Knowledge ready');
  });
});
