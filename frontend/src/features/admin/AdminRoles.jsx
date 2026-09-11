import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { PERMISSION_LABELS, ROLE_PERMISSIONS } from '@/shared/mock-data';
const ROLES = ['Admin', 'Editor', 'Viewer'];
/**
 * Read-only roles and permissions matrix.
 *
 * @returns Admin roles page
 */
export default function AdminRoles() {
    const { t } = useTranslation();
    return (<div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-brand" aria-hidden="true"/>
          <h1 className="font-display text-xl font-medium">
            {t('admin.rolesTitle')}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('admin.rolesSubtitle')}
        </p>

        <div className="mt-5 overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-2 border-b border-border bg-muted/50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span>{t('admin.permission')}</span>
            {ROLES.map((role) => (<span key={role} className="text-center">
                {role}
              </span>))}
          </div>
          {PERMISSION_LABELS.map((permission, index) => (<div key={permission} className={cn('grid grid-cols-[2fr_1fr_1fr_1fr] items-center gap-2 px-4 py-2.5 text-sm', index % 2 === 1 && 'bg-muted/20')}>
              <span className="text-foreground/90">{permission}</span>
              {ROLES.map((role) => {
                const has = ROLE_PERMISSIONS[role]?.includes(permission);
                return (<div key={role} className="flex justify-center">
                    <span className={cn('flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold', has
                        ? 'bg-brand text-brand-foreground'
                        : 'bg-muted text-muted-foreground/40')}>
                      {has ? '✓' : '—'}
                    </span>
                  </div>);
            })}
            </div>))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {t('admin.rolesFooter')}
        </p>
      </div>
    </div>);
}
