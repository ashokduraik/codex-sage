import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  getAccessToken,
  refreshAccessToken,
  setAccessToken,
  subscribeSessionCleared,
} from '@/shared/api';
import { useCurrentUser } from '@/features/auth/api/useCurrentUser.js';
import { useLogin } from '@/features/auth/api/useLogin.js';
import { useLogout } from '@/features/auth/api/useLogout.js';
import { usePasswordChange } from '@/features/auth/api/usePasswordChange.js';

const AuthContext = createContext(null);

/**
 * Builds a safe returnTo path from the current location (path + search).
 * @returns {string}
 */
function currentReturnTo() {
  const path = `${window.location.pathname}${window.location.search}`;
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return '/';
  }
  if (path.startsWith('/login')) {
    return '/';
  }
  return path;
}

/**
 * Provides real backend auth: boot refresh, current-user query, session-loss handling.
 * @param props - Provider props.
 * @returns Auth context provider.
 */
export function AuthProvider({ children }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const intentionalClearRef = useRef(false);

  const [bootState, setBootState] = useState(() =>
    getAccessToken() ? 'ready' : 'pending',
  );

  useEffect(() => {
    if (bootState !== 'pending') {
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        await refreshAccessToken();
        if (!cancelled) {
          setBootState('ready');
        }
      } catch {
        if (!cancelled) {
          setAccessToken(null);
          setBootState('signed_out');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootState]);

  const meQuery = useCurrentUser({ enabled: bootState === 'ready' });

  useEffect(() => {
    return subscribeSessionCleared(() => {
      if (intentionalClearRef.current) {
        intentionalClearRef.current = false;
        return;
      }
      void queryClient.cancelQueries();
      queryClient.clear();
      setBootState('signed_out');
      if (window.location.pathname.startsWith('/login')) {
        return;
      }
      const returnTo = encodeURIComponent(currentReturnTo());
      navigate(`/login?returnTo=${returnTo}&reason=session_expired`, { replace: true });
    });
  }, [navigate, queryClient]);

  const loginMutation = useLogin();
  const logoutMutation = useLogout();
  const passwordChangeMutation = usePasswordChange();

  const user = meQuery.data ?? null;
  const isAuthenticated = Boolean(user);
  const isLoadingAuth =
    bootState === 'pending' ||
    (bootState === 'ready' && Boolean(getAccessToken()) && meQuery.isPending);
  const authChecked =
    bootState === 'signed_out' ||
    (bootState === 'ready' &&
      (!getAccessToken() || meQuery.isSuccess || meQuery.isError));

  /**
   * Signs in and ensures the current-user query is populated.
   * @param {string} email Account email.
   * @param {string} password Account password.
   * @returns {Promise<object>} Current user from `/auth/me`.
   */
  const login = useCallback(
    async (email, password) => {
      if (!email.trim() || !password) {
        throw new Error('Email and password are required');
      }
      const nextUser = await loginMutation.mutateAsync({
        email: email.trim(),
        password,
      });
      setBootState('ready');
      return nextUser;
    },
    [loginMutation],
  );

  /**
   * Ends the session and optionally navigates to sign-in.
   * @param {boolean} [shouldRedirect=true] Whether to navigate to `/login`.
   * @returns {Promise<void>}
   */
  const logout = useCallback(
    async (shouldRedirect = true) => {
      intentionalClearRef.current = true;
      await logoutMutation.mutateAsync();
      setBootState('signed_out');
      if (shouldRedirect) {
        navigate('/login', { replace: true });
      }
    },
    [logoutMutation, navigate],
  );

  /**
   * Changes password then clears the session (caller should send the user to login).
   * @param {string} currentPassword Current password.
   * @param {string} nextPassword New password.
   * @returns {Promise<object>} Backend change result.
   */
  const changePassword = useCallback(
    async (currentPassword, nextPassword) => {
      intentionalClearRef.current = true;
      const result = await passwordChangeMutation.mutateAsync({
        currentPassword,
        newPassword: nextPassword,
      });
      setBootState('signed_out');
      return result;
    },
    [passwordChangeMutation],
  );

  const value = useMemo(
    () => ({
      user,
      isAuthenticated,
      isLoadingAuth,
      authChecked,
      login,
      logout,
      changePassword,
    }),
    [user, isAuthenticated, isLoadingAuth, authChecked, login, logout, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Reads the auth context; must be used under AuthProvider.
 * @returns Auth context value.
 * @throws When called outside AuthProvider.
 */
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
