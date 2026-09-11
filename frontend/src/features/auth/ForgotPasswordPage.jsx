import { ArrowLeft, Loader2, Mail } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AuthLayout from '@/features/auth/AuthLayout';
import { useAuth } from '@/features/auth/AuthContext';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
/**
 * Request a password-reset email (always shows success for enumeration safety).
 * @returns Forgot-password form UI.
 */
export default function ForgotPasswordPage() {
    const { t } = useTranslation();
    const auth = useAuth();
    const [email, setEmail] = useState('');
    const [loading, setLoading] = useState(false);
    const [sent, setSent] = useState(false);
    /**
     * Submit the reset request; always advances to the sent state.
     * @param event - Form submit event.
     */
    async function handleSubmit(event) {
        event.preventDefault();
        setLoading(true);
        try {
            await auth.resetPasswordRequest(email);
        }
        catch {
            // Always show success regardless of outcome (account enumeration safety).
        }
        finally {
            setLoading(false);
            setSent(true);
        }
    }
    return (<AuthLayout icon={Mail} title={t('auth.resetPassword')} subtitle={t('auth.resetSubtitle')} footer={<Link to="/login" className="text-primary font-medium hover:underline">
          <ArrowLeft className="w-3 h-3 inline mr-1" aria-hidden="true"/>
          {t('auth.backToLogin')}
        </Link>}>
      {sent ? (<p className="text-sm text-foreground text-center">{t('auth.resetLinkSent')}</p>) : (<form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t('auth.emailAddress')}</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true"/>
              <Input id="email" type="email" autoComplete="email" autoFocus placeholder={t('auth.emailPlaceholder')} value={email} onChange={(event) => setEmail(event.target.value)} className="pl-10 h-12" required disabled={loading}/>
            </div>
          </div>
          <Button type="submit" className="w-full h-12 font-medium" disabled={loading} aria-busy={loading}>
            {loading ? (<>
                <Loader2 className="w-4 h-4 mr-2 animate-spin"/>
                {t('auth.sending')}
              </>) : (t('auth.sendResetLink'))}
          </Button>
        </form>)}
    </AuthLayout>);
}
