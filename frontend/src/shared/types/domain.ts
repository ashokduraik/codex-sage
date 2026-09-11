/** Project lifecycle states shown in the product UI. */
export type ProjectStatus =
  | 'Creating'
  | 'Awaiting source'
  | 'Connecting repository'
  | 'Source received'
  | 'Processing'
  | 'Knowledge ready'
  | 'Updating'
  | 'Failed'
  | 'Partially available'
  | 'Archived';

/** Knowledge freshness / readiness states for a project. */
export type KnowledgeStatus =
  | 'Ready'
  | 'Updating'
  | 'Needs attention'
  | 'Outdated'
  | 'Partially available';

/** Node kinds in a project knowledge tree. */
export type KnowledgeNodeType =
  | 'Capability'
  | 'Workflow'
  | 'Service'
  | 'API'
  | 'Data'
  | 'Integration'
  | 'Component';

/** A node in the hierarchical knowledge map. */
export interface KnowledgeNode {
  label: string;
  type: KnowledgeNodeType | string;
  evidence?: string;
  children?: KnowledgeNode[];
}

/** File-backed evidence attached to a grounded answer. */
export interface EvidenceItem {
  file: string;
  location: string;
  snippet: string;
}

/** Alias matching the port checklist name. */
export type Evidence = EvidenceItem;

/** Chat participant role. */
export type MessageRole = 'user' | 'assistant';

/** Lifecycle status of a chat message. */
export type MessageStatus =
  | 'Completed'
  | 'Searching'
  | 'Generating'
  | 'Cancelled'
  | 'Interrupted'
  | 'Failed';

/** A single message in a conversation thread. */
export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus | string;
  createdAt: string;
  evidence?: EvidenceItem[];
  knowledgeVersion?: string;
  abstain?: boolean;
  missing?: string[];
}

/** Alias matching the port checklist name. */
export type Message = ChatMessage;

/** A project-scoped Q&A conversation. */
export interface Conversation {
  id: string;
  projectId: string;
  title: string;
  archived: boolean;
  createdAt: string;
  messages: ChatMessage[];
}

/** Processing job queue status. */
export type JobStatus = 'in_progress' | 'partial' | 'completed' | 'failed';

/** Progress state of one processing stage. */
export type StageState = 'done' | 'active' | 'pending';

/** Alias matching the port checklist name. */
export type JobStageState = StageState;

/** One labeled stage within a processing job. */
export interface JobStage {
  label: string;
  state: StageState;
}

/** Timestamped activity line for a processing job. */
export interface JobActivity {
  ts: string;
  message: string;
}

/** Background knowledge-processing job for a project. */
export interface ProcessingJob {
  id: string;
  projectId: string;
  op: string;
  status: JobStatus | string;
  progress: number;
  startedAt: string;
  completedAt?: string;
  stages: JobStage[];
  activity: JobActivity[];
  warnings: string[];
  errors: string[];
  ref?: string;
}

/** Alias matching the port checklist name. */
export type Job = ProcessingJob;

/** Organization admin role assigned to a list user. */
export type AppUserRole = 'Admin' | 'Editor' | 'Viewer';

/** Active vs deactivated admin-list user status. */
export type AppUserStatus = 'Active' | 'Inactive';

/** User row shown in the organization admin users list. */
export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: AppUserRole | string;
  status: AppUserStatus | string;
  projects: string[];
  lastActivity: string | null;
}

/** Alias matching the port checklist name. */
export type User = AppUser;

/** One audit-log entry for an administrative or sensitive action. */
export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string;
  timestamp: string;
  result: string;
  ref?: string;
}

/** In-app notification kind. */
export type NotificationKind = 'processing' | 'repo' | 'warning' | 'info';

/** User-facing notification item. */
export interface AppNotification {
  id: string;
  title: string;
  body: string;
  kind: NotificationKind | string;
  read: boolean;
  ts: string;
}

/** Alias matching the port checklist name. */
export type Notification = AppNotification;

/** Tenant organization summary shown in the shell. */
export interface Organization {
  name: string;
  plan: string;
}

/** One uploaded archive attached to a project source. */
export interface ProjectUploadItem {
  name: string;
  size: string;
  files: number;
  uploadedAt: string;
  status: string;
}

/** Repository-connected project source. */
export interface RepoProjectSource {
  type: 'repo';
  origin: string;
  provider?: string;
  repoUrl?: string;
  fullName?: string;
  baseUrl?: string;
  branch?: string;
  defaultBranch?: string;
  branches?: string[];
  lastSync?: string;
  uploads?: ProjectUploadItem[];
}

/** Upload-based project source. */
export interface UploadProjectSource {
  type: 'upload';
  origin: string;
  uploads?: ProjectUploadItem[];
  lastSync?: string;
}

/** Discriminated project source (repository vs upload). */
export type ProjectSource = RepoProjectSource | UploadProjectSource;

/** Project entity with knowledge map and source metadata. */
export interface Project {
  id: string;
  name: string;
  description: string;
  status: ProjectStatus | string;
  knowledgeStatus: KnowledgeStatus | string;
  source: ProjectSource;
  createdAt: string;
  createdBy: string;
  fileCount: number;
  excludedCount: number;
  partial: boolean;
  partialNote?: string;
  knowledgeTree: KnowledgeNode[];
  archived?: boolean;
}

/** Canned grounded answer returned by the mock Q&A helper. */
export interface MockGroundedAnswer {
  abstain: false;
  content: string;
  evidence: EvidenceItem[];
  knowledgeVersion: string;
}

/** Abstain payload when the mock Q&A cannot ground an answer. */
export interface MockAbstainAnswer {
  abstain: true;
  content: string;
  missing: string[];
}

/** Result of mockAnswerFor. */
export type MockAnswer = MockGroundedAnswer | MockAbstainAnswer;

/** Full in-memory seed bag consumed by AppDataContext. */
export interface SeedData {
  projects: Project[];
  conversations: Conversation[];
  jobs: ProcessingJob[];
  users: AppUser[];
  audit: AuditEntry[];
  notifications: AppNotification[];
}
