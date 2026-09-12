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
  partial: Object.freeze({ i18nKey: 'status.knowledgeHealth.partial', tone: 'attention' }),
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
  return project.knowledgeHealth === 'ready' || project.knowledgeHealth === 'partial';
}

/**
 * True when the project is archived.
 * @param {{ lifecycleStatus?: string } | null | undefined} project Project-like object.
 * @returns {boolean}
 */
export function isProjectArchived(project) {
  return Boolean(project && project.lifecycleStatus === 'archived');
}
