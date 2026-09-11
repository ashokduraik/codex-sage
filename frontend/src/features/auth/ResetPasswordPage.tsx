import { AlertTriangle, Loader2, Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';

import AuthLayout from '@/features/auth/AuthLayout';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';

/**
 * Resolve a user-facing message from an unknown thrown value.
 * @param err - Caught error value.
 * @param fallback - Localized fallback when no message is present.
 * @returns Error message string.
 */
function messageFromUnknown(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return fallback;
}

/**
 * Complete a password reset using the `token` query parameter.
 * @returns Reset-password form or invalid-link UI.
 */
export default function ResetPasswordPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resetToken = searchParams.get('token');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  /**
   * Submit the new password when the reset token is present.
   * @param event - Form submit event.
   */
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!resetToken) {
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    setLoading(true);
    try {
      await auth.resetPassword(resetToken, newPassword);
      toast.success(t('auth.passwordUpdated'));
      navigate('/login');
    } catch (err) {
      const message = messageFromUnknown(err, t('auth.resetFailed'));
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  if (!resetToken) {
    return (
      <AuthLayout
        icon={AlertTriangle}
        title={t('auth.invalidResetLink')}
        subtitle={t('auth.invalidResetLinkSubtitle')}
        footer={
          <Link to="/forgot-password" className="text-primary font-medium hover:underline">
            {t('auth.requestNewLink')}
          </Link>
        }
      >
        <p className="text-sm text-foreground text-center">{t('auth.invalidResetLinkBody')}</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      icon={Lock}
      title={t('auth.newPasswordTitle')}
      subtitle={t('auth.newPasswordSubtitle')}
    >
      {error && (
        <div role="alert" className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}
      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="password">{t('auth.newPassword')}</Label>
          <div className="relative">
            <Lock
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              autoFocus
              placeholder={t('auth.passwordPlaceholder')}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              className="pl-10 h-12"
              required
              disabled={loading}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">{t('auth.confirmPassword')}</Label>
          <div className="relative">
            <Lock
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              placeholder={t('auth.passwordPlaceholder')}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              className="pl-10 h-12"
              required
              disabled={loading}
            />
          </div>
        </div>
        <Button
          type="submit"
          className="w-full h-12 font-medium"
          disabled={loading}
          aria-busy={loading}
        >
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              {t('auth.resetting')}
            </>
          ) : (
            t('auth.resetPasswordAction')
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
