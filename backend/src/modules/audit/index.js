/**
 * Public surface of the audit module.
 */
export {
  AUDIT_ACTIONS,
  AUDIT_ACTION_RESOURCE_TYPES,
  isKnownAuditAction,
  resourceTypeForAction,
} from './audit.actions.js';
export { AuditEvent, AUDIT_RESULT_VALUES } from './audit.model.js';
export {
  AUDIT_CONTEXT_MAX_BYTES,
  AUDIT_CONTEXT_MAX_VALUE_CHARS,
  AUDIT_USER_AGENT_MAX_CHARS,
  sanitizeAuditContext,
  sanitizeUserAgent,
} from './audit.sanitizer.js';
export {
  AUDIT_LIST_PAGE_SIZE_DEFAULT,
  AUDIT_LIST_PAGE_SIZE_MAX,
  clampAuditListLimit,
  insertAuditEvent,
  listAuditEvents,
  findAuditEventById,
} from './audit.repository.js';
export {
  AUDITED_DENIAL_PERMISSION_KEYS,
  buildAuditContextFromRequest,
  getAuditEventForOrg,
  listAuditEventsForOrg,
  recordAuditEvent,
  shouldAuditAuthorizationDenial,
} from './audit.service.js';
export { auditRoutes } from './audit.routes.js';

import { AuditEvent } from './audit.model.js';

/** Models owned by the audit module (index sync). */
export const AUDIT_MODELS = Object.freeze([AuditEvent]);
