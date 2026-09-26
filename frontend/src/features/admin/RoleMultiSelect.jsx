import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Checkbox } from '@/shared/ui/checkbox';
import { Label } from '@/shared/ui/label';
import { cn } from '@/shared/lib/utils';

/**
 * Multi-select checklist for assigning organization roles.
 *
 * @param {{
 *   roles: Array<{ id: string, name: string }>,
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
    <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border p-3">
      {roles.map((role) => {
        const roleId = String(role.id);
        const inputId = `${idPrefix}-${roleId}`;
        const checked = selectedSet.has(roleId);
        return (
          <div key={roleId} className="flex items-center gap-2">
            <Checkbox id={inputId} checked={checked} disabled={disabled} onCheckedChange={(value) => toggleRole(roleId, value === true)} />
            <Label htmlFor={inputId} className={cn('cursor-pointer font-normal', disabled && 'opacity-70')}>
              {role.name}
            </Label>
          </div>
        );
      })}
    </div>
  );
}
