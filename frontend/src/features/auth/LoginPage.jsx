import { Loader2, Lock, LogIn, Mail } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import AuthLayout from '@/features/auth/AuthLayout';
import { useAuth } from '@/features/auth/AuthContext';
import { safeReturnTo } from '@/features/auth/authReturnTo';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
/**
 * Resolve a user-facing message from an unknown thrown value.
 * @param err - Caught error value.
 * @param fallback - Localized fallback when no message is present.
 * @returns Error message string.
 */
function messageFromUnknown(err, fallback) {
    if (err instanceof Error && err.message) {
        return err.message;
    }
    return fallback;
}
/**
 * Email/password sign-in page.
 * @returns Login form UI.
 */
export default function LoginPage() {
    const { t } = useTranslation();
    const auth = useAuth();
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const returnTo = safeReturnTo();
    /**
     * Submit email/password credentials and navigate to `returnTo` on success.
     * @param event - Form submit event.
     */
    async function handleSubmit(event) {
        event.preventDefault();
        setError('');
        setLoading(true);
        try {
            await auth.login(email, password);
            navigate(returnTo);
        }
        catch (err) {
            const message = messageFromUnknown(err, t('auth.invalidCredentials'));
            setError(message);
            toast.error(message);
        }
        finally {
            setLoading(false);
        }
    }
    const registerHref = returnTo !== '/'
        ? `/register?returnTo=${encodeURIComponent(returnTo)}`
        : '/register';
    return (<AuthLayout icon={LogIn} title={t('auth.welcomeBack')} subtitle={t('auth.loginSubtitle')} footer={<>
          {t('auth.dontHaveAccount')}{' '}
          <Link to={registerHref} className="text-primary font-medium hover:underline">
            {t('auth.createOne')}
          </Link>
        </>}>
      {error && (<div role="alert" className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>)}

      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">{t('auth.email')}</Label>
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true"/>
            <Input id="email" type="email" autoComplete="email" autoFocus placeholder={t('auth.emailPlaceholder')} value={email} onChange={(event) => setEmail(event.target.value)} className="pl-10 h-12" required disabled={loading}/>
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{t('auth.password')}</Label>
            <Link to="/forgot-password" className="text-xs text-primary hover:underline">
              {t('auth.forgotPassword')}
            </Link>
          </div>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true"/>
            <Input id="password" type="password" autoComplete="current-password" placeholder={t('auth.passwordPlaceholder')} value={password} onChange={(event) => setPassword(event.target.value)} className="pl-10 h-12" required disabled={loading}/>
          </div>
        </div>
        <Button type="submit" className="w-full h-12 font-medium" disabled={loading} aria-busy={loading}>
          {loading ? (<>
              <Loader2 className="w-4 h-4 mr-2 animate-spin"/>
              {t('auth.loggingIn')}
            </>) : (t('auth.logIn'))}
        </Button>
      </form>
    </AuthLayout>);
}
