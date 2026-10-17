/**
 * Global conversations entry — no cross-project list API yet; CTA into projects.
 */
import { Link } from 'react-router-dom';
import { Button } from '@/shared/ui/button';
import { MessagesSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/shared/components';

/**
 * Cross-project conversations placeholder with privacy copy and project CTA.
 *
 * @returns Conversations page
 */
export default function ConversationsPage() {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <h1 className="font-display text-xl font-medium">{t('conversations.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('conversations.subtitle')}</p>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{t('conversations.privacyNote')}</p>
        <div className="mt-8">
          <EmptyState
            icon={MessagesSquare}
            title={t('conversations.openProjectTitle')}
            description={t('conversations.openProjectDescription')}
            action={
              <Button asChild>
                <Link to="/projects">{t('conversations.openProjects')}</Link>
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}
