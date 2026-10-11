/**
 * Role assignment list for invite and edit-roles dialogs.
 */
import { useMemo } from 'react';
import { cn } from '@/shared/lib/utils';
import { useTranslation } from 'react-i18next';

/**
 * Multi-select list for assigning organization roles.
 *
 * @param {{
 *   roles: Array<{ id: string, name: string, code?: string }>,
 *   selectedRoleIds: string[],
 *   onChange: (roleIds: string[]) => void,
 *   disabled?: boolean,
 *   idPrefix?: string,
 * }} props Control props.
 * @returns Role multi-select UI.
 */
export function RoleMultiSelect({ roles, selectedRoleIds, onChange, disabled = false, idPrefix = 'role' }) {
  const { t } = useTranslation();
  const selectedSet = useMemo(() => new Set(selectedRoleIds.map(String)), [selectedRoleIds]);

  /**
   * Toggles one role id in the selection.
   * @param {string} roleId Role id.
   * @param {boolean} checked Next checked state.
   */
  function toggleRole(roleId, checked) {
    const next = new Set(selectedSet);
    if (checked) {
      next.add(String(roleId));
    } else {
      next.delete(String(roleId));
    }
    onChange([...next]);
  }

  if (!roles.length) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t('admin.noRolesAvailable')}
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {roles.map((role, index) => {
        const roleId = String(role.id);
        const checked = selectedSet.has(roleId);
        return (
          <label
            key={roleId}
            className={cn(
              'flex w-full items-center justify-between gap-3 border-b border-border px-4 py-2.5 last:border-b-0',
              index % 2 === 1 && 'bg-muted/20',
              disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/40',
            )}
          >
            <input
              id={`${idPrefix}-${roleId}`}
              type="checkbox"
              className="sr-only"
              checked={checked}
              disabled={disabled}
              aria-label={role.name}
              onChange={(event) => toggleRole(roleId, event.target.checked)}
            />
            <span className="min-w-0">
              <span className="block text-sm text-foreground/90">{role.name}</span>
              {role.code ? <span className="mt-0.5 block font-mono text-xs text-muted-foreground">{role.code}</span> : null}
            </span>
            <span
              className={cn(
                'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                checked ? 'bg-brand text-brand-foreground' : 'bg-muted text-muted-foreground/40',
              )}
              aria-hidden="true"
            >
              {checked ? '✓' : '—'}
            </span>
          </label>
        );
      })}
    </div>
  );
}
