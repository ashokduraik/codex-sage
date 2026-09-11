import { Link, useNavigate } from 'react-router-dom';
import { MessageSquare, BookOpen, Search, FolderKanban, ArrowRight, } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/shared/components';
import { Button } from '@/shared/ui/button';
import { useAppData } from '@/shared/mock-data';
const TAB_META = {
    chat: {
        labelKey: 'nav.chat',
        descKey: 'projects.pickerChatDesc',
        icon: MessageSquare,
    },
    knowledge: {
        labelKey: 'nav.knowledge',
        descKey: 'projects.pickerKnowledgeDesc',
        icon: BookOpen,
    },
    search: {
        labelKey: 'nav.search',
        descKey: 'projects.pickerSearchDesc',
        icon: Search,
    },
};
/**
 * Intermediate picker when a global tab needs a project selection.
 *
 * @param props - Which destination tab to open after pick
 * @returns Project picker page
 */
export default function ProjectPickerPage({ tab }) {
    const { t } = useTranslation();
    const { projects } = useAppData();
    const navigate = useNavigate();
    const meta = TAB_META[tab];
    const Icon = meta.icon;
    const active = projects.filter((project) => project.status !== 'Archived');
    if (active.length === 0) {
        return (<div className="h-full overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl px-6 py-8">
          <EmptyState icon={FolderKanban} title={t('projects.pickerEmptyTitle')} description={t('projects.pickerEmptyDescription')} action={<Button onClick={() => navigate('/projects')} className="bg-brand text-brand-foreground hover:bg-brand/90">
                {t('projects.create')}
              </Button>}/>
        </div>
      </div>);
    }
    return (<div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <div className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-brand" aria-hidden="true"/>
          <h1 className="font-display text-xl font-medium">{t(meta.labelKey)}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t(meta.descKey)} {t('projects.pickerPickContinue')}
        </p>
        <div className="mt-5 divide-y divide-border rounded-lg border border-border bg-card">
          {active.map((project) => (<Link key={project.id} to={`/projects/${project.id}/${tab}`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
              <FolderKanban className="h-4 w-4 text-muted-foreground" aria-hidden="true"/>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{project.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {project.description}
                </div>
              </div>
              <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true"/>
            </Link>))}
        </div>
      </div>
    </div>);
}
