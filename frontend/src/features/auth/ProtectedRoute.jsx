import { useAuth } from '@/features/auth/AuthContext';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

/**
 * Default full-screen spinner shown while auth is resolving.
 * @returns Loading spinner element.
 */
function DefaultFallback() {
  return (
    <div className="fixed inset-0 flex items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-slate-200 border-t-slate-800" />
    </div>
  );
}

/**
 * Redirects unauthenticated callers to sign-in with a safe returnTo.
 * @returns Navigate element.
 */
function LoginRedirect() {
  const location = useLocation();
  const path = `${location.pathname}${location.search}`;
  const returnTo = path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') ? encodeURIComponent(path) : encodeURIComponent('/');
  return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
}

/**
 * Renders nested routes when authenticated; otherwise the unauthenticated element.
 * Forces `/change-password` when the user must change their password.
 * @param props - Route guard props.
 * @returns Outlet, fallback spinner, redirect, or unauthenticated UI.
 */
export default function ProtectedRoute({ fallback = <DefaultFallback />, unauthenticatedElement = <LoginRedirect /> }) {
  const { isAuthenticated, isLoadingAuth, authChecked, user } = useAuth();
  const location = useLocation();

  if (isLoadingAuth || !authChecked) {
    return fallback;
  }
  if (!isAuthenticated) {
    return unauthenticatedElement;
  }
  if (user?.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return <Outlet />;
}
