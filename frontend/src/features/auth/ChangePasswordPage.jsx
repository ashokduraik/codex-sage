import { useState } from 'react';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { Button } from '@/shared/ui/button';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AuthLayout from '@/features/auth/AuthLayout';
import { useAuth } from '@/features/auth/AuthContext';
import { KeyRound, Loader2, Lock } from 'lucide-react';
import { correlationFromUnknown, messageFromUnknown } from '@/shared/api';

/**
 * Signed-in password change (forced when mustChangePassword, or voluntary).
 * @returns Change-password form UI.
 */
export default function ChangePasswordPage() {
  const { t } = useTranslation();
  const auth = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [correlationId, setCorrelationId] = useState('');
  const [loading, setLoading] = useState(false);
  const forced = Boolean(auth.user?.mustChangePassword);

  /**
   * Submit the password change and return to sign-in.
   * @param event - Form submit event.
   */
  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setCorrelationId('');
    if (newPassword !== confirmPassword) {
      setError(t('auth.passwordMismatch'));
      return;
    }
    setLoading(true);
    try {
      await auth.changePassword(currentPassword, newPassword);
      navigate('/login?reason=password_changed', { replace: true });
    } catch (err) {
      setError(messageFromUnknown(err, t('auth.passwordChangeFailed')));
      setCorrelationId(correlationFromUnknown(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout
      icon={KeyRound}
      title={forced ? t('auth.mustChangePasswordTitle') : t('auth.changePasswordTitle')}
      subtitle={forced ? t('auth.mustChangePasswordSubtitle') : t('auth.changePasswordSubtitle')}
    >
      {error && (
        <div role="alert" className="mb-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <p>{error}</p>
          {correlationId ? <p className="mt-1 text-xs opacity-80">{t('auth.correlationReference', { id: correlationId })}</p> : null}
        </div>
      )}

      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="currentPassword">{t('auth.currentPassword')}</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              className="h-12 pl-10"
              required
              disabled={loading}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="newPassword">{t('auth.newPassword')}</Label>
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            className="h-12"
            required
            disabled={loading}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">{t('auth.confirmPassword')}</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="h-12"
            required
            disabled={loading}
          />
        </div>
        <Button type="submit" className="h-12 w-full font-medium" disabled={loading} aria-busy={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t('auth.changingPassword')}
            </>
          ) : (
            t('auth.savePassword')
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}
