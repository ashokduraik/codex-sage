import type { ReactNode } from 'react';
import { Outlet } from 'react-router-dom';

import { useAuth } from '@/features/auth/AuthContext';

interface ProtectedRouteProps {
  /** UI shown while auth state is still loading. */
  fallback?: ReactNode;
  /** UI shown when the user is not authenticated. */
  unauthenticatedElement: ReactNode;
}

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
 * Renders nested routes when authenticated; otherwise the unauthenticated element.
 * @param props - Route guard props.
 * @returns Outlet, fallback spinner, or unauthenticated UI.
 */
export default function ProtectedRoute({
  fallback = <DefaultFallback />,
  unauthenticatedElement,
}: ProtectedRouteProps) {
  const { isAuthenticated, isLoadingAuth, authChecked } = useAuth();

  if (isLoadingAuth || !authChecked) {
    return fallback;
  }

  if (!isAuthenticated) {
    return unauthenticatedElement;
  }

  return <Outlet />;
}
