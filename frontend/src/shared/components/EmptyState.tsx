import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/shared/lib/utils';

export interface EmptyStateProps {
  /** Optional leading icon. */
  icon?: LucideIcon;
  /** Primary empty-state heading. */
  title: string;
  /** Optional supporting description. */
  description?: string;
  /** Optional action slot (e.g. a button). */
  action?: ReactNode;
  /** Extra class names for the root container. */
  className?: string;
}

/**
 * Centered empty-state placeholder with optional icon and action.
 * @param props - Empty state props.
 * @returns Empty state UI.
 */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center px-6 py-16',
        className,
      )}
    >
      {Icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="h-6 w-6" aria-hidden="true" />
        </div>
      )}
      <h3 className="font-display text-lg font-medium text-foreground">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
