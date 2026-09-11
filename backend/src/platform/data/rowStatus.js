/**
 * Row visibility status — never overload for domain lifecycle.
 * @see .cursor/rules/row-status.mdc
 */

/** Active (visible) row. */
export const ROW_STATUS_ACTIVE = 'A';

/** Soft-deleted (hidden) row. */
export const ROW_STATUS_DELETED = 'D';

/** Allowed values for the row `status` field. */
export const ROW_STATUS_VALUES = Object.freeze([ROW_STATUS_ACTIVE, ROW_STATUS_DELETED]);
