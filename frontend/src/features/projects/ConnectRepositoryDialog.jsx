import { useState } from 'react';
import { GitBranch, Loader2, AlertCircle, Check, ExternalLink, ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/shared/ui/dialog';
import { useRepositoryProbe } from './hooks/useRepositoryProbe.js';
import { useRepositoryAttach } from './hooks/useRepositoryAttach.js';

/** Known probe statuses from Phase 30. */
export const KNOWN_PROBE_STATUSES = Object.freeze(['connected', 'authentication_required', 'access_denied', 'not_found', 'unreachable']);

const PROBE_STATUS_MESSAGE_KEYS = Object.freeze({
  connected: 'sources.verified',
  authentication_required: 'sources.authRequired',
  access_denied: 'sources.probeAccessDenied',
  not_found: 'sources.probeNotFound',
  unreachable: 'sources.probeUnreachable',
});

const REASON_MESSAGE_KEYS = Object.freeze({
  token_missing: 'sources.probeReasonTokenMissing',
  token_invalid: 'sources.probeReasonTokenInvalid',
  insufficient_scope: 'sources.probeReasonInsufficientScope',
  repository_not_found: 'sources.probeReasonNotFound',
  network_unreachable: 'sources.probeReasonUnreachable',
  provider_unavailable: 'sources.probeReasonUnavailable',
  provider_rate_limited: 'sources.probeReasonRateLimited',
  provider_not_supported: 'sources.probeReasonNotSupported',
  host_not_allowed: 'sources.probeReasonHostNotAllowed',
});

/**
 * Maps a probe DTO to the next dialog step and a localized message key.
 * Never returns raw provider text.
 * @param {import('./api/repositoriesApi.js').RepositoryProbeDto | null | undefined} probe
 *   Probe response.
 * @returns {{
 *   step: 'confirm' | 'token' | 'error',
 *   status: string,
 *   reasonCode: string | null,
 *   messageKey: string,
 *   fullName: string | null,
 * }}
 */
export function mapProbeResult(probe) {
  const rawStatus = probe && typeof probe.probeStatus === 'string' ? probe.probeStatus : '';
  const status = KNOWN_PROBE_STATUSES.includes(rawStatus) ? rawStatus : 'unknown';
  const step = status === 'connected' ? 'confirm' : status === 'authentication_required' ? 'token' : 'error';
  const reasonCode = probe?.reason && typeof probe.reason.code === 'string' ? probe.reason.code : null;
  const fullName = probe?.repository && typeof probe.repository.fullName === 'string' ? probe.repository.fullName : null;
  let messageKey = REASON_MESSAGE_KEYS[reasonCode] ?? PROBE_STATUS_MESSAGE_KEYS[status];
  if (!messageKey) {
    messageKey = 'sources.probeUnknown';
  }
  if (status === 'authentication_required' && fullName && reasonCode === 'token_missing') {
    messageKey = 'sources.authRequiredNamed';
  }
  return { step, status, reasonCode, messageKey, fullName };
}

/**
 * Builds the provider token-settings URL from probe identity.
 * @param {{
 *   provider?: string,
 *   hostKind?: string,
 *   baseUrl?: string | null,
 * }} identity Probe identity fields.
 * @returns {string}
 */
export function tokenPageUrl(identity) {
  if (identity.provider === 'github') {
    return 'https://github.com/settings/tokens/new';
  }
  const base = identity.hostKind === 'gitlab_self_hosted' && typeof identity.baseUrl === 'string' ? identity.baseUrl.replace(/\/+$/, '') : '';
  if (base) {
    return `${base}/-/user_settings/personal_access_tokens`;
  }
  return 'https://gitlab.com/-/user_settings/personal_access_tokens';
}

/**
 * Multi-step dialog to probe and attach a GitHub/GitLab repository.
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   projectId: string,
 *   onConnected?: (result: import('./api/repositoriesApi.js').RepositoryAttachResult) => void,
 * }} props Dialog props.
 * @returns {import('react').ReactElement}
 */
export function ConnectRepositoryDialog({ open, onOpenChange, projectId, onConnected }) {
  const { t } = useTranslation();
  const probeMutation = useRepositoryProbe();
  const attachMutation = useRepositoryAttach();
  const [step, setStep] = useState('url');
  const [repoUrl, setRepoUrl] = useState('');
  const [token, setToken] = useState('');
  const [probe, setProbe] = useState(null);
  const [mappedError, setMappedError] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [branch, setBranch] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  /**
   * Resets dialog state and clears the token from memory.
   */
  function reset() {
    setStep('url');
    setRepoUrl('');
    setToken('');
    setProbe(null);
    setMappedError(null);
    setSubmitError(null);
    setBranch('');
    setIdempotencyKey(crypto.randomUUID());
    probeMutation.reset();
    attachMutation.reset();
  }

  /**
   * Probes the current URL, optionally with a token.
   * @param {string} [withToken] Token to include.
   */
  async function handleProbe(withToken) {
    setMappedError(null);
    setSubmitError(null);
    try {
      const result = await probeMutation.probe({
        projectId,
        repositoryUrl: repoUrl.trim(),
        accessToken: withToken,
      });
      const mapped = mapProbeResult(result);
      if (mapped.step === 'token') {
        setProbe(result);
        setStep('token');
        return;
      }
      if (mapped.step === 'confirm') {
        setProbe(result);
        setBranch(result.defaultBranch || result.branches?.[0] || '');
        setStep('confirm');
        return;
      }
      setMappedError(mapped);
    } catch (error) {
      setSubmitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Continues from the token step after the user pastes a token.
   */
  async function handleContinueWithToken() {
    if (!token.trim()) {
      setMappedError(null);
      setSubmitError(new Error(t('sources.tokenRequired')));
      return;
    }
    await handleProbe(token.trim());
  }

  /**
   * Attaches the verified repository.
   */
  async function handleConnect() {
    if (!probe || !branch) {
      return;
    }
    setMappedError(null);
    setSubmitError(null);
    try {
      const result = await attachMutation.attach({
        projectId,
        repositoryUrl: repoUrl.trim(),
        selectedBranch: branch,
        accessToken: token.trim() || undefined,
        idempotencyKey,
      });
      onConnected?.(result);
      onOpenChange(false);
      reset();
    } catch (error) {
      setSubmitError(error instanceof Error ? error : new Error(String(error)));
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_IN_FLIGHT') {
        return;
      }
      setIdempotencyKey(crypto.randomUUID());
    }
  }

  const probing = probeMutation.isPending;
  const attaching = attachMutation.isPending;
  const alert = resolveAlert(t, mappedError, submitError);
  const branches = Array.isArray(probe?.branches) ? probe.branches : [];
  const fullName = probe?.repository?.fullName ?? '';

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          reset();
        }
      }}
    >
      <DialogContent className="w-[calc(100vw-1.5rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-brand" aria-hidden="true" />
            {t('sources.connectDialogTitle')}
          </DialogTitle>
          <DialogDescription>{t('sources.connectDialogDescription')}</DialogDescription>
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
                  if (event.key === 'Enter' && repoUrl.trim()) {
                    void handleProbe();
                  }
                }}
                autoFocus
              />
            </div>
            {alert ? <StepAlert text={alert.text} reference={alert.reference} /> : null}
            <p className="text-xs text-muted-foreground">{t('sources.connectTip')}</p>
          </div>
        )}

        {step === 'token' && (
          <div className="space-y-4">
            <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
              {fullName ? t('sources.authRequiredNamed', { fullName }) : t('sources.authRequired')}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="token">{t('sources.accessToken')}</Label>
              <Input
                id="token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={t('sources.accessTokenPlaceholder')}
                autoFocus
              />
              <p className="text-xs text-muted-foreground">{t('sources.tokenWriteOnly')}</p>
            </div>
            <TokenHelp provider={probe?.provider} hostKind={probe?.hostKind} baseUrl={probe?.baseUrl} />
            {alert ? <StepAlert text={alert.text} reference={alert.reference} /> : null}
          </div>
        )}

        {step === 'confirm' && probe && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="font-medium break-all">{fullName}</span> {t('sources.verifiedShort')}
            </div>
            <div className="space-y-1.5">
              <Label>{t('sources.selectBranch')}</Label>
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger>
                  <SelectValue placeholder={t('sources.selectBranch')} />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branchName) => (
                    <SelectItem key={branchName} value={branchName}>
                      {branchName}
                      {branchName === probe.defaultBranch ? ` (${t('sources.defaultBranch')})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {probe.branchesTruncated ? <p className="text-xs text-muted-foreground">{t('sources.branchesTruncated')}</p> : null}
            </div>
            <p className="text-xs text-muted-foreground">{t('sources.connectionSaved')}</p>
            {alert ? <StepAlert text={alert.text} reference={alert.reference} /> : null}
          </div>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:gap-0">
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
              <Button onClick={() => void handleProbe()} disabled={!repoUrl.trim() || probing} aria-busy={probing}>
                {probing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
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
                  setToken('');
                  setMappedError(null);
                  setSubmitError(null);
                }}
              >
                <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.back')}
              </Button>
              <Button onClick={() => void handleContinueWithToken()} disabled={probing} aria-busy={probing}>
                {probing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
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
              <Button onClick={() => void handleConnect()} disabled={attaching || !branch} aria-busy={attaching}>
                {attaching ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
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

  /**
   * Resolves an alert string from a probe mapping or an HTTP error.
   * @param {import('react-i18next').TFunction} t Translator.
   * @param {{ messageKey: string, fullName: string | null } | null} mapped Probe map.
   * @param {unknown} submitError Last thrown error.
   * @returns {{ text: string, reference?: string } | null}
   */
  function resolveAlert(t, mapped, submitError) {
    if (submitError instanceof ApiError) {
      return { text: submitError.message, reference: submitError.correlationId };
    }
    if (submitError instanceof Error) {
      return { text: submitError.message };
    }
    if (mapped) {
      return { text: t(mapped.messageKey, { fullName: mapped.fullName ?? '' }) };
    }
    return null;
  }
}

/**
 * Provider-specific token creation help. Scope text stays administrator-defined.
 * @param {{
 *   provider?: string,
 *   hostKind?: string,
 *   baseUrl?: string | null,
 * }} props Probe identity.
 * @returns {import('react').ReactElement}
 */
function TokenHelp({ provider, hostKind, baseUrl }) {
  const { t } = useTranslation();
  const isGitLab = provider === 'gitlab';
  const isSelfHosted = isGitLab && hostKind === 'gitlab_self_hosted';
  const href = tokenPageUrl({ provider, hostKind, baseUrl });
  return (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
      <div className="font-medium text-foreground">
        {isSelfHosted
          ? t('sources.gitlabSelfHostedTokenHelpTitle')
          : isGitLab
            ? t('sources.gitlabTokenHelpTitle')
            : t('sources.githubTokenHelpTitle')}
      </div>
      <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>{isSelfHosted ? t('sources.gitlabSelfHostedTokenHelp1') : isGitLab ? t('sources.gitlabTokenHelp1') : t('sources.githubTokenHelp1')}</li>
        <li>{isGitLab ? t('sources.gitlabTokenHelp2') : t('sources.githubTokenHelp2')}</li>
        <li>{isGitLab ? t('sources.gitlabTokenHelp3') : t('sources.githubTokenHelp3')}</li>
        {!isGitLab ? <li>{t('sources.githubTokenHelp4')}</li> : null}
      </ol>
      <a href={href} target="_blank" rel="noreferrer" className="mt-2 inline-flex flex-wrap items-center gap-1 text-brand hover:underline">
        {t('sources.openTokenPage')} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}

/**
 * Error panel shared across dialog steps.
 * @param {{ text: string, reference?: string }} props Alert content.
 * @returns {import('react').ReactElement}
 */
function StepAlert({ text, reference }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p>{text}</p>
        {reference ? <p className="mt-1 text-xs text-muted-foreground">{reference}</p> : null}
      </div>
    </div>
  );
}

export default ConnectRepositoryDialog;
