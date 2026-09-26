import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';

/**
 * Single mapping from backend lifecycle / knowledge-health codes to badge metadata.
 * No other module should compare against backend status strings except archived/askable.
 */

/** @typedef {'neutral' | 'attention' | 'progress' | 'success' | 'danger'} StatusTone */

/**
 * @typedef {object} StatusBadgeMeta
 * @property {string} i18nKey Localization key for the label.
 * @property {StatusTone} tone Visual tone token.
 */

/** @type {Readonly<Record<string, Readonly<StatusBadgeMeta>>>} */
export const LIFECYCLE_STATUS_MAP = Object.freeze({
  creating: Object.freeze({ i18nKey: 'status.lifecycle.creating', tone: 'neutral' }),
  awaiting_source: Object.freeze({
    i18nKey: 'status.lifecycle.awaitingSource',
    tone: 'attention',
  }),
  connecting_repository: Object.freeze({
    i18nKey: 'status.lifecycle.connectingRepository',
    tone: 'progress',
  }),
  source_received: Object.freeze({
    i18nKey: 'status.lifecycle.sourceReceived',
    tone: 'progress',
  }),
  processing: Object.freeze({ i18nKey: 'status.lifecycle.processing', tone: 'progress' }),
  knowledge_ready: Object.freeze({
    i18nKey: 'status.lifecycle.knowledgeReady',
    tone: 'success',
  }),
  updating: Object.freeze({ i18nKey: 'status.lifecycle.updating', tone: 'progress' }),
  failed: Object.freeze({ i18nKey: 'status.lifecycle.failed', tone: 'danger' }),
  partially_available: Object.freeze({
    i18nKey: 'status.lifecycle.partiallyAvailable',
    tone: 'attention',
  }),
  archived: Object.freeze({ i18nKey: 'status.lifecycle.archived', tone: 'neutral' }),
});

/** @type {Readonly<Record<string, Readonly<StatusBadgeMeta>>>} */
export const KNOWLEDGE_HEALTH_MAP = Object.freeze({
  none: Object.freeze({ i18nKey: 'status.knowledgeHealth.none', tone: 'neutral' }),
  updating: Object.freeze({ i18nKey: 'status.knowledgeHealth.updating', tone: 'progress' }),
  ready: Object.freeze({ i18nKey: 'status.knowledgeHealth.ready', tone: 'success' }),
  partially_available: Object.freeze({
    i18nKey: 'status.knowledgeHealth.partiallyAvailable',
    tone: 'attention',
  }),
  stale: Object.freeze({ i18nKey: 'status.knowledgeHealth.stale', tone: 'attention' }),
  failed: Object.freeze({ i18nKey: 'status.knowledgeHealth.failed', tone: 'danger' }),
});

/** @type {Readonly<StatusBadgeMeta>} */
export const UNKNOWN_LIFECYCLE_META = Object.freeze({
  i18nKey: 'status.lifecycle.unknown',
  tone: 'neutral',
});

/** @type {Readonly<StatusBadgeMeta>} */
export const UNKNOWN_KNOWLEDGE_HEALTH_META = Object.freeze({
  i18nKey: 'status.knowledgeHealth.unknown',
  tone: 'neutral',
});

/**
 * Maps a backend lifecycle code to badge metadata.
 * @param {string | null | undefined} code Backend lifecycleStatus.
 * @returns {Readonly<StatusBadgeMeta>}
 */
export function mapLifecycleStatus(code) {
  if (typeof code !== 'string' || code.length === 0) {
    return UNKNOWN_LIFECYCLE_META;
  }
  return LIFECYCLE_STATUS_MAP[code] ?? UNKNOWN_LIFECYCLE_META;
}

/**
 * Maps a backend knowledgeHealth code to badge metadata.
 * @param {string | null | undefined} code Backend knowledgeHealth.
 * @returns {Readonly<StatusBadgeMeta>}
 */
export function mapKnowledgeHealth(code) {
  if (typeof code !== 'string' || code.length === 0) {
    return UNKNOWN_KNOWLEDGE_HEALTH_META;
  }
  return KNOWLEDGE_HEALTH_MAP[code] ?? UNKNOWN_KNOWLEDGE_HEALTH_META;
}

/**
 * True when the project may accept chat questions.
 * @param {{ lifecycleStatus?: string, knowledgeHealth?: string } | null | undefined} project
 *   Project-like object.
 * @returns {boolean}
 */
export function isProjectAskable(project) {
  if (!project) {
    return false;
  }
  if (project.lifecycleStatus === 'archived') {
    return false;
  }
  return project.knowledgeHealth === 'ready' || project.knowledgeHealth === 'partially_available';
}

/**
 * True when the project is archived.
 * @param {{ lifecycleStatus?: string } | null | undefined} project Project-like object.
 * @returns {boolean}
 */
export function isProjectArchived(project) {
  return Boolean(project && project.lifecycleStatus === 'archived');
}

const PROJECT_STYLES = {
  Creating: 'bg-muted text-muted-foreground',
  'Awaiting source': 'bg-amber-100 text-amber-800',
  'Connecting repository': 'bg-blue-100 text-blue-800',
  'Source received': 'bg-blue-100 text-blue-800',
  Processing: 'bg-blue-100 text-blue-800',
  'Knowledge ready': 'bg-emerald-100 text-emerald-800',
  Updating: 'bg-blue-100 text-blue-800',
  Failed: 'bg-red-100 text-red-700',
  'Partially available': 'bg-amber-100 text-amber-800',
  Archived: 'bg-muted text-muted-foreground',
};
const KNOWLEDGE_STYLES = {
  Ready: 'bg-emerald-100 text-emerald-800',
  Updating: 'bg-blue-100 text-blue-800',
  'Needs attention': 'bg-amber-100 text-amber-800',
  Outdated: 'bg-muted text-muted-foreground',
  'Partially available': 'bg-amber-100 text-amber-800',
};
const KNOWLEDGE_DOT = {
  Ready: 'bg-emerald-500',
  Updating: 'bg-blue-500 animate-pulse',
  'Needs attention': 'bg-amber-500',
  Outdated: 'bg-muted-foreground',
  'Partially available': 'bg-amber-500',
};

/** @type {Readonly<Record<string, string>>} */
const TONE_STYLES = Object.freeze({
  neutral: 'bg-muted text-muted-foreground',
  attention: 'bg-amber-100 text-amber-800',
  progress: 'bg-blue-100 text-blue-800',
  success: 'bg-emerald-100 text-emerald-800',
  danger: 'bg-red-100 text-red-700',
});

/** @type {Readonly<Record<string, string>>} */
const TONE_DOTS = Object.freeze({
  neutral: 'bg-muted-foreground',
  attention: 'bg-amber-500',
  progress: 'bg-blue-500 animate-pulse',
  success: 'bg-emerald-500',
  danger: 'bg-red-500',
});

/**
 * Colored pill for a project lifecycle status (mock display strings).
 * @param {{ status: string }} props Badge props.
 * @returns Status badge element.
 */
export function ProjectStatusBadge({ status }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        PROJECT_STYLES[status] || 'bg-muted text-muted-foreground',
      )}
    >
      {t(`status.${status}`, { defaultValue: status })}
    </span>
  );
}

/**
 * Colored pill with a status dot for knowledge freshness (mock display strings).
 * @param {{ status: string }} props Badge props.
 * @returns Status badge element.
 */
export function KnowledgeStatusBadge({ status }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        KNOWLEDGE_STYLES[status] || 'bg-muted text-muted-foreground',
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', KNOWLEDGE_DOT[status] || 'bg-muted-foreground')} aria-hidden="true" />
      {t(`status.${status}`, { defaultValue: status })}
    </span>
  );
}

/**
 * Lifecycle badge driven by backend lifecycleStatus codes.
 * @param {{ code: string | null | undefined }} props Badge props.
 * @returns Status badge element.
 */
export function ProjectLifecycleBadge({ code }) {
  const { t } = useTranslation();
  const meta = mapLifecycleStatus(code);
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', TONE_STYLES[meta.tone])}>
      {t(meta.i18nKey)}
    </span>
  );
}

/**
 * Knowledge-health badge driven by backend knowledgeHealth codes.
 * @param {{ code: string | null | undefined }} props Badge props.
 * @returns Status badge element.
 */
export function KnowledgeHealthBadge({ code }) {
  const { t } = useTranslation();
  const meta = mapKnowledgeHealth(code);
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium', TONE_STYLES[meta.tone])}>
      <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOTS[meta.tone])} aria-hidden="true" />
      {t(meta.i18nKey)}
    </span>
  );
}
