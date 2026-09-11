import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import {
  KNOWLEDGE_STATES,
  mockAnswerFor,
  seed,
  uid,
} from '@/shared/mock-data/mockData';
import type {
  AppNotification,
  AppUser,
  AppUserRole,
  AuditEntry,
  ChatMessage,
  Conversation,
  Organization,
  ProcessingJob,
  Project,
  ProjectSource,
  ProjectUploadItem,
  RepoProjectSource,
} from '@/shared/types/domain';

/** Options when listing conversations for a project. */
export interface GetConversationsOptions {
  archived?: boolean;
}

/** Optional streaming callbacks for askQuestion. */
export interface AskQuestionOptions {
  onStatus?: (status: string) => void;
  onStream?: (partialContent: string) => void;
  signal?: AbortSignal;
}

/** Input for creating a project from the create-project dialog. */
export interface CreateProjectInput {
  name: string;
  description?: string;
  sourceType: 'repo' | 'upload';
}

/** Fields accepted when inviting / creating an admin list user. */
export interface CreateUserInput {
  name: string;
  email: string;
  role: AppUserRole;
}

/** Repository metadata passed to {@link AppDataContextValue.attachRepository}. */
export type AttachRepositoryInput = Partial<RepoProjectSource> & { fullName: string };

/** Upload metadata passed to {@link AppDataContextValue.addUpload}. */
export type AddUploadInput = ProjectUploadItem;

/** Public surface of the mock app-data context. */
export interface AppDataContextValue {
  org: Organization;
  projects: Project[];
  conversations: Conversation[];
  jobs: ProcessingJob[];
  users: AppUser[];
  audit: AuditEntry[];
  notifications: AppNotification[];
  activeJob: ProcessingJob | undefined;
  getProject: (id: string) => Project | undefined;
  createProject: (input: CreateProjectInput) => Project;
  updateProject: (id: string, patch: Partial<Project> & { source?: Partial<ProjectSource> }) => void;
  archiveProject: (id: string, archived: boolean) => void;
  attachRepository: (id: string, repo: AttachRepositoryInput) => void;
  addUpload: (id: string, upload: AddUploadInput) => void;
  startProcessing: (projectId: string, op: string) => ProcessingJob;
  retryJob: (jobId: string) => void;
  getConversations: (projectId: string, options?: GetConversationsOptions) => Conversation[];
  getConversation: (id: string) => Conversation | undefined;
  createConversation: (projectId: string, title?: string) => Conversation;
  renameConversation: (id: string, title: string) => void;
  archiveConversation: (id: string, archived: boolean) => void;
  deleteConversation: (id: string) => void;
  addMessage: (convId: string, message: ChatMessage) => void;
  updateMessage: (convId: string, msgId: string, patch: Partial<ChatMessage>) => void;
  editUserMessage: (convId: string, msgId: string, newContent: string) => string;
  askQuestion: (convId: string, question: string, options?: AskQuestionOptions) => Promise<void>;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  updateUser: (id: string, patch: Partial<AppUser>) => void;
  createUser: (user: CreateUserInput) => AppUser;
  removeUser: (id: string) => void;
  logAudit: (action: string, target: string, result?: string, extra?: Record<string, unknown>) => void;
  KNOWLEDGE_STATES: typeof KNOWLEDGE_STATES;
}

const AppDataContext = createContext<AppDataContextValue | null>(null);

/**
 * Delay helper used to simulate async answer streaming.
 * @param ms - Milliseconds to wait.
 * @returns Promise that resolves after `ms`.
 */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface AppDataProviderProps {
  children: ReactNode;
}

/**
 * Provides in-memory mock app state (projects, chat, jobs, admin) to the tree.
 * @param props - Provider props.
 * @returns Context provider element.
 */
export function AppDataProvider({ children }: AppDataProviderProps) {
  const [projects, setProjects] = useState<Project[]>(seed.projects);
  const [conversations, setConversations] = useState<Conversation[]>(seed.conversations);
  const [jobs, setJobs] = useState<ProcessingJob[]>(seed.jobs);
  const [users, setUsers] = useState<AppUser[]>(seed.users);
  const [audit, setAudit] = useState<AuditEntry[]>(seed.audit);
  const [notifications, setNotifications] = useState<AppNotification[]>(seed.notifications);
  const [org] = useState<Organization>({ name: 'Acme Corp', plan: 'Enterprise' });

  const logAudit = useCallback(
    (action: string, target: string, result = 'Success', extra: Record<string, unknown> = {}) => {
      setAudit((prev) => [
        {
          id: uid('a'),
          actor: 'You',
          action,
          target,
          timestamp: new Date().toISOString(),
          result,
          ...extra,
        } as AuditEntry,
        ...prev,
      ]);
    },
    [],
  );

  const getProject = useCallback((id: string) => projects.find((p) => p.id === id), [projects]);

  const createProject = useCallback(
    ({ name, description, sourceType }: CreateProjectInput) => {
      const project: Project = {
        id: uid('prj'),
        name,
        description: description || '',
        status: sourceType === 'repo' ? 'Connecting repository' : 'Awaiting source',
        knowledgeStatus: 'Needs attention',
        source:
          sourceType === 'repo'
            ? { type: 'repo', origin: 'Repository', uploads: [] }
            : { type: 'upload', origin: 'Upload', uploads: [] },
        createdAt: new Date().toISOString(),
        createdBy: 'you',
        fileCount: 0,
        excludedCount: 0,
        partial: false,
        knowledgeTree: [],
      };
      setProjects((prev) => [project, ...prev]);
      logAudit('Created project', name);
      return project;
    },
    [logAudit],
  );

  const updateProject = useCallback(
    (id: string, patch: Partial<Project> & { source?: Partial<ProjectSource> }) => {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                ...patch,
                source: { ...p.source, ...(patch.source || {}) } as ProjectSource,
              }
            : p,
        ),
      );
    },
    [],
  );

  const archiveProject = useCallback(
    (id: string, archived: boolean) => {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                status: archived ? 'Archived' : 'Knowledge ready',
                archived,
              }
            : p,
        ),
      );
      logAudit(
        archived ? 'Archived project' : 'Restored project',
        projects.find((p) => p.id === id)?.name || id,
      );
    },
    [logAudit, projects],
  );

  // Declared before attachRepository / addUpload so those callbacks can depend on it.
  const startProcessing = useCallback((projectId: string, op: string) => {
    const job: ProcessingJob = {
      id: uid('job'),
      projectId,
      op,
      status: 'in_progress',
      progress: 5,
      startedAt: new Date().toISOString(),
      stages: [
        { label: 'Source received', state: 'active' },
        { label: 'Project files identified', state: 'pending' },
        { label: 'Understanding application functionality', state: 'pending' },
        { label: 'Finalizing', state: 'pending' },
      ],
      activity: [{ ts: new Date().toISOString(), message: `${op} started` }],
      warnings: [],
      errors: [],
    };
    setJobs((prev) => [job, ...prev]);
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId ? { ...p, status: 'Processing', knowledgeStatus: 'Updating' } : p,
      ),
    );
    return job;
  }, []);

  const attachRepository = useCallback(
    (id: string, repo: AttachRepositoryInput) => {
      setProjects((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                status: 'Source received',
                source: { ...p.source, type: 'repo', ...repo } as RepoProjectSource,
              }
            : p,
        ),
      );
      logAudit('Connected repository', repo.fullName);
      startProcessing(id, 'Initial processing');
    },
    [logAudit, startProcessing],
  );

  const addUpload = useCallback(
    (id: string, upload: AddUploadInput) => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p;
          const existingUploads = p.source.uploads ?? [];
          return {
            ...p,
            status: 'Source received',
            source: {
              type: 'upload',
              origin: 'Upload',
              uploads: [...existingUploads, upload],
              lastSync: p.source.lastSync,
            },
          };
        }),
      );
      logAudit('Uploaded source', upload.name);
      startProcessing(id, 'Knowledge update');
    },
    [logAudit, startProcessing],
  );

  const retryJob = useCallback((jobId: string) => {
    setJobs((prev) =>
      prev.map((j) =>
        j.id === jobId
          ? {
              ...j,
              status: 'in_progress' as const,
              progress: 5,
              errors: [],
              completedAt: undefined,
              stages: j.stages.map((s, i) => ({
                ...s,
                state: i === 0 ? ('active' as const) : ('pending' as const),
              })),
              activity: [...j.activity, { ts: new Date().toISOString(), message: 'Retry started' }],
            }
          : j,
      ),
    );
  }, []);

  const getConversations = useCallback(
    (projectId: string, { archived = false }: GetConversationsOptions = {}) =>
      conversations.filter((c) => c.projectId === projectId && c.archived === archived),
    [conversations],
  );

  const getConversation = useCallback(
    (id: string) => conversations.find((c) => c.id === id),
    [conversations],
  );

  const createConversation = useCallback((projectId: string, title = 'New Chat') => {
    const conversation: Conversation = {
      id: uid('conv'),
      projectId,
      title,
      archived: false,
      createdAt: new Date().toISOString(),
      messages: [],
    };
    setConversations((prev) => [conversation, ...prev]);
    return conversation;
  }, []);

  const renameConversation = useCallback((id: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  }, []);

  const archiveConversation = useCallback(
    (id: string, archived: boolean) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, archived } : c)));
      logAudit(
        archived ? 'Archived conversation' : 'Restored conversation',
        conversations.find((c) => c.id === id)?.title || id,
      );
    },
    [logAudit, conversations],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== id));
      logAudit('Deleted conversation', conversations.find((c) => c.id === id)?.title || id);
    },
    [logAudit, conversations],
  );

  const addMessage = useCallback((convId: string, message: ChatMessage) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, message] } : c)),
    );
  }, []);

  const updateMessage = useCallback((convId: string, msgId: string, patch: Partial<ChatMessage>) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: c.messages.map((m) => (m.id === msgId ? { ...m, ...patch } : m)),
            }
          : c,
      ),
    );
  }, []);

  const editUserMessage = useCallback((convId: string, msgId: string, newContent: string) => {
    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== convId) return c;
        const idx = c.messages.findIndex((m) => m.id === msgId);
        if (idx === -1) return c;
        const kept = c.messages.slice(0, idx);
        const newMsg: ChatMessage = {
          id: uid('m'),
          role: 'user',
          content: newContent,
          status: 'Completed',
          createdAt: new Date().toISOString(),
        };
        return { ...c, messages: [...kept, newMsg] };
      }),
    );
    return newContent;
  }, []);

  const askQuestion = useCallback(
    async (
      convId: string,
      question: string,
      { onStatus, onStream, signal }: AskQuestionOptions = {},
    ) => {
      const userMsg: ChatMessage = {
        id: uid('m'),
        role: 'user',
        content: question,
        status: 'Completed',
        createdAt: new Date().toISOString(),
      };
      addMessage(convId, userMsg);
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId && (c.title === 'New Chat' || c.messages.length <= 1)
            ? { ...c, title: question.slice(0, 60) }
            : c,
        ),
      );

      const answer = mockAnswerFor(question);
      const assistantId = uid('m');
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        status: 'Searching',
        createdAt: new Date().toISOString(),
        ...(answer.abstain
          ? { abstain: true, missing: answer.missing }
          : { evidence: answer.evidence, knowledgeVersion: answer.knowledgeVersion }),
      };
      addMessage(convId, assistantMsg);

      onStatus?.('Searching project knowledge…');
      await wait(650);
      if (signal?.aborted) {
        updateMessage(convId, assistantId, { status: 'Cancelled' });
        return;
      }
      onStatus?.('Generating answer…');
      updateMessage(convId, assistantId, { status: 'Generating' });
      await wait(450);

      const full = answer.content;
      let i = 0;
      await new Promise<void>((resolve) => {
        const step = () => {
          if (signal?.aborted) {
            updateMessage(convId, assistantId, { status: 'Interrupted' });
            resolve();
            return;
          }
          i += Math.max(2, Math.round(full.length / 90));
          const slice = full.slice(0, i);
          updateMessage(convId, assistantId, { content: slice });
          onStream?.(slice);
          if (i < full.length) {
            setTimeout(step, 16);
          } else {
            updateMessage(convId, assistantId, { status: 'Completed' });
            resolve();
          }
        };
        step();
      });
    },
    [addMessage, updateMessage],
  );

  const markNotificationRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const updateUser = useCallback(
    (id: string, patch: Partial<AppUser>) => {
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
      logAudit('Updated user', users.find((u) => u.id === id)?.name || id);
    },
    [logAudit, users],
  );

  const createUser = useCallback(
    (user: CreateUserInput) => {
      const created: AppUser = {
        id: uid('u'),
        status: 'Active',
        projects: [],
        lastActivity: null,
        ...user,
      };
      setUsers((prev) => [...prev, created]);
      logAudit('Created user', created.name);
      return created;
    },
    [logAudit],
  );

  const removeUser = useCallback(
    (id: string) => {
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, status: 'Inactive' } : u)));
      logAudit('Deactivated user', users.find((u) => u.id === id)?.name || id);
    },
    [logAudit, users],
  );

  const activeJob = jobs.find((j) => j.status === 'in_progress');

  const value = useMemo<AppDataContextValue>(
    () => ({
      org,
      projects,
      conversations,
      jobs,
      users,
      audit,
      notifications,
      activeJob,
      getProject,
      createProject,
      updateProject,
      archiveProject,
      attachRepository,
      addUpload,
      startProcessing,
      retryJob,
      getConversations,
      getConversation,
      createConversation,
      renameConversation,
      archiveConversation,
      deleteConversation,
      addMessage,
      updateMessage,
      editUserMessage,
      askQuestion,
      markNotificationRead,
      markAllNotificationsRead,
      updateUser,
      createUser,
      removeUser,
      logAudit,
      KNOWLEDGE_STATES,
    }),
    [
      org,
      projects,
      conversations,
      jobs,
      users,
      audit,
      notifications,
      activeJob,
      getProject,
      createProject,
      updateProject,
      archiveProject,
      attachRepository,
      addUpload,
      startProcessing,
      retryJob,
      getConversations,
      getConversation,
      createConversation,
      renameConversation,
      archiveConversation,
      deleteConversation,
      addMessage,
      updateMessage,
      editUserMessage,
      askQuestion,
      markNotificationRead,
      markAllNotificationsRead,
      updateUser,
      createUser,
      removeUser,
      logAudit,
    ],
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

/**
 * Read the mock app-data context; must be used under AppDataProvider.
 * @returns App data context value.
 * @throws When called outside AppDataProvider.
 */
export function useAppData(): AppDataContextValue {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error('useAppData must be used within AppDataProvider');
  return ctx;
}
