import { useState } from 'react';
import {
  GitBranch,
  Loader2,
  AlertCircle,
  Check,
  ExternalLink,
  ArrowLeft,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/shared/ui/dialog';
import { useAppData, type AttachRepositoryInput } from '@/shared/mock-data';

export interface ConnectRepositoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onConnected?: () => void;
}

interface ProbeSuccess {
  provider: 'github' | 'gitlab';
  fullName: string;
  baseUrl: string | null;
  defaultBranch: string;
  branches: string[];
  description: string;
  authRequired?: false;
  error?: never;
}

interface ProbeAuthRequired {
  authRequired: true;
  provider: 'github' | 'gitlab';
  baseUrl: string | null;
  fullName?: string;
  error?: never;
}

interface ProbeError {
  error: 'unreachable' | 'notfound' | 'accessdenied';
  authRequired?: false;
}

type ProbeResult = ProbeSuccess | ProbeAuthRequired | ProbeError;

interface TokenHelpProps {
  provider?: 'github' | 'gitlab';
  baseUrl?: string | null;
}

/**
 * Simulated repository probe used by the connect dialog.
 *
 * @param repoUrl - Repository URL
 * @param token - Optional access token
 * @returns Probe outcome
 */
async function mockProbe(
  repoUrl: string,
  token?: string,
): Promise<ProbeResult> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const url = repoUrl.trim().toLowerCase();
  const isGitLab = url.includes('gitlab');
  let host = 'github.com';
  let baseUrl: string | null = null;
  try {
    const parsed = new URL(repoUrl);
    host = parsed.hostname;
    if (isGitLab && host !== 'gitlab.com') {
      baseUrl = `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    /* ignore invalid URL during probe */
  }

  if (url.includes('unreachable') || url.includes('localhost:9999')) {
    return { error: 'unreachable' };
  }
  if (url.includes('notfound') || url.includes('does-not-exist')) {
    return { error: 'notfound' };
  }

  const isPrivate =
    url.includes('private') ||
    (isGitLab && host !== 'gitlab.com' && !url.includes('public'));
  if (isPrivate && !token) {
    return {
      authRequired: true,
      provider: isGitLab ? 'gitlab' : 'github',
      baseUrl,
    };
  }
  if (isPrivate && token && token.length < 4) {
    return { error: 'accessdenied' };
  }

  const parts = repoUrl.replace(/\/+$/, '').split('/').slice(-2);
  const fullName = parts.join('/').replace(/\.git$/, '');
  const provider = isGitLab ? 'gitlab' : 'github';
  return {
    provider,
    fullName,
    baseUrl,
    defaultBranch: 'main',
    branches: ['main', 'develop', 'release/2.4'],
    description: `${fullName} — connected via ${
      provider === 'gitlab' && baseUrl
        ? 'self-hosted GitLab'
        : provider === 'gitlab'
          ? 'GitLab'
          : 'GitHub'
    }.`,
  };
}

/**
 * Provider-specific token creation help.
 *
 * @param props - Provider and optional self-hosted base URL
 * @returns Help panel
 */
function TokenHelp({ provider, baseUrl }: TokenHelpProps) {
  const { t } = useTranslation();

  if (provider === 'github') {
    return (
      <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <div className="font-medium text-foreground">
          {t('sources.githubTokenHelpTitle')}
        </div>
        <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>{t('sources.githubTokenHelp1')}</li>
          <li>{t('sources.githubTokenHelp2')}</li>
          <li>
            {t('sources.githubTokenHelp3')}{' '}
            <code className="rounded bg-background px-1 font-mono text-xs">
              repo
            </code>
          </li>
          <li>{t('sources.githubTokenHelp4')}</li>
        </ol>
        <a
          href="https://github.com/settings/tokens/new"
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-brand hover:underline"
        >
          {t('sources.openTokenPage')}{' '}
          <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>
    );
  }

  const isSelfHosted = provider === 'gitlab' && !!baseUrl;
  const tokenUrl = isSelfHosted
    ? `${baseUrl}/-/user_settings/personal_access_tokens`
    : 'https://gitlab.com/-/user_settings/personal_access_tokens';

  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <div className="font-medium text-foreground">
        {isSelfHosted
          ? t('sources.gitlabSelfHostedTokenHelpTitle')
          : t('sources.gitlabTokenHelpTitle')}
      </div>
      <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>
          {isSelfHosted
            ? t('sources.gitlabSelfHostedTokenHelp1')
            : t('sources.gitlabTokenHelp1')}
        </li>
        <li>
          {t('sources.gitlabTokenHelp2')}{' '}
          <code className="rounded bg-background px-1 font-mono text-xs">
            api
          </code>
        </li>
        <li>{t('sources.gitlabTokenHelp3')}</li>
      </ol>
      <a
        href={tokenUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-2 inline-flex items-center gap-1 text-brand hover:underline"
      >
        {t('sources.openTokenPage')}{' '}
        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}

/**
 * Multi-step dialog to probe and attach a GitHub/GitLab repository.
 *
 * @param props - Dialog props including project id
 * @returns Connect repository dialog
 */
export function ConnectRepositoryDialog({
  open,
  onOpenChange,
  projectId,
  onConnected,
}: ConnectRepositoryDialogProps) {
  const { t } = useTranslation();
  const { attachRepository } = useAppData();
  const [step, setStep] = useState<'url' | 'token' | 'confirm'>('url');
  const [repoUrl, setRepoUrl] = useState('');
  const [token, setToken] = useState('');
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeSuccess | ProbeAuthRequired | null>(
    null,
  );
  const [branch, setBranch] = useState('');
  const [description, setDescription] = useState('');
  const [connecting, setConnecting] = useState(false);

  /**
   * Reset dialog state to the initial URL step.
   */
  const reset = () => {
    setStep('url');
    setRepoUrl('');
    setToken('');
    setProbing(false);
    setError(null);
    setProbe(null);
    setBranch('');
    setDescription('');
    setConnecting(false);
  };

  /**
   * Probe the repository URL, optionally with a token.
   *
   * @param withToken - Token to include in the probe
   */
  const handleProbe = async (withToken?: string) => {
    setError(null);
    setProbing(true);
    const result = await mockProbe(repoUrl, withToken);
    setProbing(false);
    if (result.error === 'notfound') {
      setError(t('sources.probeNotFound'));
      return;
    }
    if (result.error === 'unreachable') {
      setError(t('sources.probeUnreachable'));
      return;
    }
    if (result.error === 'accessdenied') {
      setError(t('sources.probeAccessDenied'));
      return;
    }
    if ('authRequired' in result && result.authRequired) {
      setProbe(result);
      setStep('token');
      return;
    }
    if ('error' in result && result.error) {
      setError(t('sources.probeNotFound'));
      return;
    }
    const success = result as ProbeSuccess;
    setProbe(success);
    setBranch(success.defaultBranch);
    setDescription(success.description || '');
    setStep('confirm');
  };

  /**
   * Continue after the user pastes an access token.
   */
  const handleContinueWithToken = async () => {
    if (!token.trim()) {
      setError(t('sources.tokenRequired'));
      return;
    }
    setProbing(true);
    setError(null);
    const result = await mockProbe(repoUrl, token);
    setProbing(false);
    if (result.error === 'accessdenied') {
      setError(t('sources.probeAccessDenied'));
      return;
    }
    if ('error' in result && result.error) {
      setError(t('sources.probeNotFound'));
      return;
    }
    if ('authRequired' in result && result.authRequired) {
      setError(t('sources.probeAccessDenied'));
      return;
    }
    const success = result as ProbeSuccess;
    setProbe(success);
    setBranch(success.defaultBranch);
    setDescription(success.description || '');
    setStep('confirm');
  };

  /**
   * Attach the verified repository to the project.
   */
  const handleConnect = async () => {
    if (!probe || !('fullName' in probe) || !probe.fullName) return;
    setConnecting(true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const success = probe as ProbeSuccess;
    const payload: AttachRepositoryInput = {
      provider: success.provider,
      repoUrl,
      fullName: success.fullName,
      baseUrl: success.baseUrl ?? undefined,
      branch,
      defaultBranch: success.defaultBranch,
      branches: success.branches,
      origin:
        success.provider === 'gitlab'
          ? success.baseUrl
            ? 'GitLab (self-hosted)'
            : 'GitLab'
          : 'GitHub',
      lastSync: new Date().toISOString(),
    };
    attachRepository(projectId, payload);
    setConnecting(false);
    onConnected?.();
    onOpenChange(false);
    reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) reset();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-brand" aria-hidden="true" />
            {t('sources.connectDialogTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('sources.connectDialogDescription')}
          </DialogDescription>
        </DialogHeader>

        {step === 'url' && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="repo-url">{t('sources.repoUrl')}</Label>
              <Input
                id="repo-url"
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder={t('sources.repoUrlPlaceholder')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && repoUrl) {
                    void handleProbe();
                  }
                }}
                autoFocus
              />
            </div>
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive"
              >
                <AlertCircle
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                {error}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {t('sources.connectTip')}
            </p>
          </div>
        )}

        {step === 'token' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              {t('sources.authRequired')}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="token">{t('sources.accessToken')}</Label>
              <Input
                id="token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={t('sources.accessTokenPlaceholder')}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                {t('sources.tokenWriteOnly')}
              </p>
            </div>
            <TokenHelp provider={probe?.provider} baseUrl={probe?.baseUrl} />
            {error && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive"
              >
                <AlertCircle
                  className="mt-0.5 h-4 w-4 shrink-0"
                  aria-hidden="true"
                />
                {error}
              </div>
            )}
          </div>
        )}

        {step === 'confirm' && probe && 'branches' in probe && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <Check className="h-4 w-4" aria-hidden="true" />{' '}
              <span className="font-medium">{probe.fullName}</span>{' '}
              {t('sources.verifiedShort')}
            </div>
            <div className="space-y-1.5">
              <Label>{t('sources.selectBranch')}</Label>
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger>
                  <SelectValue placeholder={t('sources.selectBranch')} />
                </SelectTrigger>
                <SelectContent>
                  {probe.branches.map((branchName) => (
                    <SelectItem key={branchName} value={branchName}>
                      {branchName}
                      {branchName === probe.defaultBranch
                        ? ` (${t('sources.defaultBranch')})`
                        : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="desc">
                {t('projects.description')}{' '}
                <span className="font-normal text-muted-foreground">
                  ({t('common.optional')})
                </span>
              </Label>
              <Textarea
                id="desc"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {step === 'url' && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  reset();
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => void handleProbe()}
                disabled={!repoUrl.trim() || probing}
                aria-busy={probing}
              >
                {probing ? (
                  <>
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    {t('sources.connecting')}
                  </>
                ) : (
                  t('sources.connect')
                )}
              </Button>
            </>
          )}
          {step === 'token' && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setStep('url');
                  setError(null);
                }}
              >
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.back')}
              </Button>
              <Button
                onClick={() => void handleContinueWithToken()}
                disabled={probing}
                aria-busy={probing}
              >
                {probing ? (
                  <>
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    {t('sources.verifying')}
                  </>
                ) : (
                  t('common.next')
                )}
              </Button>
            </>
          )}
          {step === 'confirm' && (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  reset();
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => void handleConnect()}
                disabled={connecting || !branch}
                aria-busy={connecting}
              >
                {connecting ? (
                  <>
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                    {t('sources.connecting')}
                  </>
                ) : (
                  t('sources.connect')
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ConnectRepositoryDialog;
