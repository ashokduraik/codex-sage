import { useState } from 'react';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Button } from '@/shared/ui/button';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AuthLayout from '@/features/auth/AuthLayout';
import { useAuth } from '@/features/auth/AuthContext';
import { Loader2, Lock, LogIn, Mail } from 'lucide-react';
import { correlationFromUnknown, messageFromUnknown } from '@/shared/api';

/**
 * Resolve `?returnTo=` to a safe same-origin path, else `/`.
 *
 * The same-origin check alone is not enough: a value like `/.//evil.com` or
 * `/\evil.com` parses same-origin but normalizes to a protocol-relative
 * `//evil.com` when assigned to `location.href` — an open redirect. So require the
 * resolved path to be exactly one leading slash (no `//` prefix, no backslash).
 *
 * @returns {string} A same-origin path+search string safe for client-side navigation.
 */
export function safeReturnTo() {
  const raw = new URLSearchParams(window.location.search).get('returnTo');
  if (!raw) {
    return '/';
  }
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) {
      return '/';
    }
    for (const param of ['access_token', 'clear_access_token', 'app_id', 'app_base_url', 'functions_version', 'from_url']) {
      url.searchParams.delete(param);
    }
    const path = url.pathname + url.search;
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
      return '/';
    }
    return path;
  } catch {
    return '/';
  }
}

/**
 * Email/password sign-in page against the real backend.
 * @returns Login form UI.
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [correlationId, setCorrelationId] = useState('');
  const [loading, setLoading] = useState(false);
  const returnTo = safeReturnTo();
  const noticeReasonParam = new URLSearchParams(window.location.search).get('reason');
  const noticeReason = noticeReasonParam === 'session_expired' || noticeReasonParam === 'password_changed' ? noticeReasonParam : null;

  /**
   * Submit email/password credentials and navigate on success.
   * @param event - Form submit event.
   */
  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setCorrelationId('');
    setLoading(true);
    try {
      const user = await auth.login(email, password);
      if (user?.mustChangePassword) {
        navigate('/change-password', { replace: true });
        return;
      }
      navigate(returnTo, { replace: true });
    } catch (err) {
      setError(messageFromUnknown(err, t('auth.invalidCredentials')));
      setCorrelationId(correlationFromUnknown(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      icon={LogIn}
      title={t('auth.welcomeBack')}
      subtitle={t('auth.loginSubtitle')}
      footer={
        <>
          <span className="block">{t('auth.accountsByAdmin')}</span>
          <span className="mt-1 block">{t('auth.contactAdminForPassword')}</span>
        </>
      }
    >
      {noticeReason === 'session_expired' && (
        <div role="status" className="mb-4 rounded-lg bg-muted p-3 text-sm text-foreground">
          {t('auth.sessionExpired')}
        </div>
      )}
      {noticeReason === 'password_changed' && (
        <div role="status" className="mb-4 rounded-lg bg-muted p-3 text-sm text-foreground">
          {t('auth.passwordChangedSignInAgain')}
        </div>
      )}
      {error && (
        <div role="alert" className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <p>{error}</p>
          {correlationId ? <p className="mt-1 text-xs opacity-80">{t('auth.correlationReference', { id: correlationId })}</p> : null}
        </div>
      )}

      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">{t('auth.email')}</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              placeholder={t('auth.emailPlaceholder')}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-12 pl-10"
              required
              disabled={loading}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t('auth.password')}</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder={t('auth.passwordPlaceholder')}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-12 pl-10"
              required
              disabled={loading}
            />
          </div>
        </div>
        <Button type="submit" className="h-12 w-full font-medium" disabled={loading} aria-busy={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('auth.loggingIn')}
            </>
          ) : (
            t('auth.logIn')
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
