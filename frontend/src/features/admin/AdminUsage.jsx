import { BarChart3, MessageSquare, Cpu, Database, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, } from 'recharts';
import { useAppData } from '@/shared/mock-data';
const STATS = [
    {
        labelKey: 'admin.statQuestions',
        value: '1,284',
        icon: MessageSquare,
        subKey: 'admin.statLast30',
    },
    {
        labelKey: 'admin.statTokens',
        value: '4.2M',
        icon: Cpu,
        subKey: 'admin.statLast30',
    },
    {
        labelKey: 'admin.statContext',
        value: '63%',
        icon: Layers,
        subKey: 'admin.statAvgConversation',
    },
    {
        labelKey: 'admin.statSourceVolume',
        value: '7,032',
        icon: Database,
        subKey: 'admin.statFilesAcross',
    },
];
const BY_PROJECT = [
    { name: 'Atlas', questions: 612, tokens: 2100 },
    { name: 'Orion', questions: 318, tokens: 940 },
    { name: 'Helios', questions: 354, tokens: 1160 },
];
/**
 * Usage metrics dashboard with chart and per-user breakdown.
 *
 * @returns Admin usage page
 */
export default function AdminUsage() {
    const { t } = useTranslation();
    const { users } = useAppData();
    return (<div className="h-full overflow-y-auto scrollbar-thin">
      <div className="mx-auto max-w-4xl px-6 py-8">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-brand" aria-hidden="true"/>
          <h1 className="font-display text-xl font-medium">
            {t('admin.usageTitle')}
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t('admin.usageSubtitle')}
        </p>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {STATS.map((stat) => (<div key={stat.labelKey} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2 text-muted-foreground">
                <stat.icon className="h-4 w-4" aria-hidden="true"/>
                <span className="text-xs font-medium">{t(stat.labelKey)}</span>
              </div>
              <div className="mt-2 text-2xl font-semibold text-foreground">
                {stat.value}
              </div>
              <div className="text-xs text-muted-foreground">
                {t(stat.subKey)}
              </div>
            </div>))}
        </div>

        <div className="mt-6 rounded-xl border border-border bg-card p-4">
          <h2 className="text-sm font-semibold">
            {t('admin.questionsByProject')}
          </h2>
          <div className="mt-3 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={BY_PROJECT}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false}/>
                <XAxis dataKey="name" tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false}/>
                <YAxis tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false}/>
                <Tooltip contentStyle={{
            borderRadius: 8,
            border: '1px solid hsl(var(--border))',
            fontSize: 12,
        }}/>
                <Bar dataKey="questions" fill="hsl(var(--brand))" radius={[4, 4, 0, 0]}/>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="mt-6">
          <h2 className="text-sm font-semibold">{t('admin.usageByUser')}</h2>
          <div className="mt-2 divide-y divide-border rounded-lg border border-border bg-card">
            {users
            .filter((user) => user.status === 'Active')
            .map((user, index) => (<div key={user.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <span>{user.name}</span>
                  <span className="text-muted-foreground">
                    {t('admin.userUsageLine', {
                questions: [612, 318, 354][index % 3],
                tokens: [2.1, 0.9, 1.2][index % 3],
            })}
                  </span>
                </div>))}
          </div>
        </div>
      </div>
    </div>);
}
