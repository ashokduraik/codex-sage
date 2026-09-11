import { Loader2, Lock, Mail, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import AuthLayout from '@/features/auth/AuthLayout';
import { useAuth } from '@/features/auth/AuthContext';
import { safeReturnTo } from '@/features/auth/authReturnTo';
import GoogleIcon from '@/features/auth/GoogleIcon';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/shared/ui/input-otp';
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
 * Registration and email OTP verification page.
 * @returns Register / OTP UI.
 */
export default function RegisterPage() {
    const { t } = useTranslation();
    const auth = useAuth();
    const navigate = useNavigate();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [showOtp, setShowOtp] = useState(false);
    const [otpCode, setOtpCode] = useState('');
    const returnTo = safeReturnTo();
    /**
     * Create the account and advance to the OTP step.
     * @param event - Form submit event.
     */
    async function handleSubmit(event) {
        event.preventDefault();
        setError('');
        if (password !== confirmPassword) {
            setError(t('auth.passwordMismatch'));
            return;
        }
        setLoading(true);
        try {
            await auth.register(email, password, '');
            setShowOtp(true);
        }
        catch (err) {
            const message = messageFromUnknown(err, t('auth.registrationFailed'));
            setError(message);
            toast.error(message);
        }
        finally {
            setLoading(false);
        }
    }
    /**
     * Verify the OTP and navigate to `returnTo` on success.
     */
    async function handleVerify() {
        setError('');
        setLoading(true);
        try {
            await auth.verifyOtp(otpCode);
            navigate(returnTo);
        }
        catch (err) {
            const message = messageFromUnknown(err, t('auth.otpInvalid'));
            setError(message);
            toast.error(message);
        }
        finally {
            setLoading(false);
        }
    }
    /**
     * Resend the OTP for the pending registration email.
     */
    async function handleResend() {
        setError('');
        try {
            await auth.resendOtp();
            toast.success(t('auth.codeSentTitle'), {
                description: t('auth.codeSentDescription'),
            });
        }
        catch (err) {
            const message = messageFromUnknown(err, t('auth.resendFailed'));
            setError(message);
            toast.error(message);
        }
    }
    /**
     * Sign in with the mock Google provider and navigate to `returnTo`.
     */
    async function handleGoogle() {
        setError('');
        setLoading(true);
        try {
            await auth.loginWithGoogle();
            navigate(returnTo);
        }
        catch (err) {
            const message = messageFromUnknown(err, t('auth.registrationFailed'));
            setError(message);
            toast.error(message);
        }
        finally {
            setLoading(false);
        }
    }
    const loginHref = returnTo !== '/' ? `/login?returnTo=${encodeURIComponent(returnTo)}` : '/login';
    if (showOtp) {
        return (<AuthLayout icon={Mail} title={t('auth.verifyEmail')} subtitle={t('auth.verifySubtitle', { email })}>
        {error && (<div role="alert" className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
            {error}
          </div>)}
        <div className="flex justify-center mb-6">
          <InputOTP maxLength={6} value={otpCode} onChange={setOtpCode} autoFocus autoComplete="one-time-code" disabled={loading}>
            <InputOTPGroup>
              <InputOTPSlot index={0}/>
              <InputOTPSlot index={1}/>
              <InputOTPSlot index={2}/>
              <InputOTPSlot index={3}/>
              <InputOTPSlot index={4}/>
              <InputOTPSlot index={5}/>
            </InputOTPGroup>
          </InputOTP>
        </div>
        <Button type="button" className="w-full h-12 font-medium" onClick={() => void handleVerify()} disabled={loading || otpCode.length < 6} aria-busy={loading}>
          {loading ? (<>
              <Loader2 className="w-4 h-4 mr-2 animate-spin"/>
              {t('auth.verifying')}
            </>) : (t('auth.verify'))}
        </Button>
        <p className="text-center text-sm text-muted-foreground mt-4">
          {t('auth.didntReceiveCode')}{' '}
          <button type="button" onClick={() => void handleResend()} className="text-primary font-medium hover:underline">
            {t('auth.resend')}
          </button>
        </p>
      </AuthLayout>);
    }
    return (<AuthLayout icon={UserPlus} title={t('auth.createAccount')} subtitle={t('auth.registerSubtitle')} footer={<>
          {t('auth.alreadyHaveAccount')}{' '}
          <Link to={loginHref} className="text-primary font-medium hover:underline">
            {t('auth.logIn')}
          </Link>
        </>}>
      <Button type="button" variant="outline" className="w-full h-12 text-sm font-medium mb-6" onClick={() => void handleGoogle()} disabled={loading} aria-busy={loading}>
        <GoogleIcon className="w-5 h-5 mr-2"/>
        {t('auth.continueWithGoogle')}
      </Button>

      <div className="relative mb-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border"/>
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-3 text-muted-foreground">{t('auth.or')}</span>
        </div>
      </div>

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
          <Label htmlFor="password">{t('auth.password')}</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true"/>
            <Input id="password" type="password" autoComplete="new-password" placeholder={t('auth.passwordPlaceholder')} value={password} onChange={(event) => setPassword(event.target.value)} className="pl-10 h-12" required disabled={loading}/>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">{t('auth.confirmPassword')}</Label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" aria-hidden="true"/>
            <Input id="confirm" type="password" autoComplete="new-password" placeholder={t('auth.passwordPlaceholder')} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="pl-10 h-12" required disabled={loading}/>
          </div>
        </div>
        <Button type="submit" className="w-full h-12 font-medium" disabled={loading} aria-busy={loading}>
          {loading ? (<>
              <Loader2 className="w-4 h-4 mr-2 animate-spin"/>
              {t('auth.creatingAccount')}
            </>) : (t('auth.createAccountAction'))}
        </Button>
      </form>
    </AuthLayout>);
}
