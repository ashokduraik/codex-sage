import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';

import { uid } from '@/shared/mock-data/mockData';

/** localStorage key for the mock auth session JSON. */
export const AUTH_STORAGE_KEY = 'codex-sage-auth';

/** Authenticated user shape for the mock auth layer. */
export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  role: 'admin' | 'user';
}

interface StoredAuthSession {
  user: AuthUser;
}

/** Public surface of the mock auth context. */
export interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoadingAuth: boolean;
  authChecked: boolean;
  pendingEmail: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName?: string) => Promise<void>;
  verifyOtp: (code: string) => Promise<void>;
  resendOtp: () => Promise<void>;
  resetPasswordRequest: (email: string) => Promise<void>;
  resetPassword: (token: string, newPassword: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: (shouldRedirect?: boolean) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Read a previously stored mock auth session from localStorage.
 * @returns Parsed session or null when missing/invalid.
 */
function readStoredSession(): StoredAuthSession | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredAuthSession | AuthUser;
    // Support both `{ user }` wrapper and a bare AuthUser payload.
    if ('user' in parsed && parsed.user?.email && parsed.user.id) {
      return parsed as StoredAuthSession;
    }
    if ('email' in parsed && parsed.email && 'id' in parsed && parsed.id) {
      return { user: parsed as AuthUser };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist a mock auth session to localStorage.
 * @param session - Session payload to store.
 */
function writeStoredSession(session: StoredAuthSession): void {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

/**
 * Build a mock AuthUser from an email address.
 * @param email - Sign-in email.
 * @param fullName - Optional display name.
 * @returns AuthUser with admin role for `admin@` emails, otherwise `user`.
 */
function buildAuthUser(email: string, fullName?: string): AuthUser {
  const normalized = email.trim().toLowerCase();
  const inferredName =
    fullName?.trim() ||
    normalized
      .split('@')[0]
      ?.replace(/[._-]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()) ||
    'User';
  return {
    id: uid('user'),
    email: normalized,
    full_name: inferredName,
    role: normalized.startsWith('admin@') ? 'admin' : 'user',
  };
}

interface AuthProviderProps {
  children: ReactNode;
}

/**
 * Provides mock email/OTP/Google auth backed by localStorage.
 * @param props - Provider props.
 * @returns Auth context provider.
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const navigate = useNavigate();
  const initialSession = readStoredSession();
  const [user, setUser] = useState<AuthUser | null>(initialSession?.user ?? null);
  const [isAuthenticated, setIsAuthenticated] = useState(Boolean(initialSession));
  const [isLoadingAuth] = useState(false);
  const [authChecked] = useState(true);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [pendingFullName, setPendingFullName] = useState<string | undefined>(undefined);

  /**
   * Establish an authenticated session for the given user.
   * @param nextUser - User to store as the current session.
   */
  const establishSession = useCallback((nextUser: AuthUser) => {
    writeStoredSession({ user: nextUser });
    setUser(nextUser);
    setIsAuthenticated(true);
    setPendingEmail(null);
    setPendingFullName(undefined);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      if (!email.trim() || !password) {
        throw new Error('Email and password are required');
      }
      establishSession(buildAuthUser(email));
    },
    [establishSession],
  );

  const register = useCallback(async (email: string, password: string, fullName?: string) => {
    if (!email.trim() || !password) {
      throw new Error('Email and password are required');
    }
    setPendingEmail(email.trim().toLowerCase());
    setPendingFullName(fullName);
  }, []);

  const verifyOtp = useCallback(
    async (code: string) => {
      if (!pendingEmail) {
        throw new Error('No pending registration');
      }
      if (!code || code.length !== 6) {
        throw new Error('Enter a 6-character code');
      }
      establishSession(buildAuthUser(pendingEmail, pendingFullName));
    },
    [establishSession, pendingEmail, pendingFullName],
  );

  const resendOtp = useCallback(async () => {
    if (!pendingEmail) {
      throw new Error('No pending registration');
    }
  }, [pendingEmail]);

  const resetPasswordRequest = useCallback(async (_email: string) => {
    // Mock: always succeeds without revealing whether the email exists.
  }, []);

  const resetPassword = useCallback(async (token: string, newPassword: string) => {
    if (!token) {
      throw new Error('Reset token is required');
    }
    if (!newPassword) {
      throw new Error('Password is required');
    }
  }, []);

  const loginWithGoogle = useCallback(async () => {
    establishSession(buildAuthUser('google.user@acme.io', 'Google User'));
  }, [establishSession]);

  const logout = useCallback(
    (shouldRedirect = true) => {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      setUser(null);
      setIsAuthenticated(false);
      setPendingEmail(null);
      setPendingFullName(undefined);
      if (shouldRedirect) {
        navigate('/login');
      }
    },
    [navigate],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated,
      isLoadingAuth,
      authChecked,
      pendingEmail,
      login,
      register,
      verifyOtp,
      resendOtp,
      resetPasswordRequest,
      resetPassword,
      loginWithGoogle,
      logout,
    }),
    [
      user,
      isAuthenticated,
      isLoadingAuth,
      authChecked,
      pendingEmail,
      login,
      register,
      verifyOtp,
      resendOtp,
      resetPasswordRequest,
      resetPassword,
      loginWithGoogle,
      logout,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Read the mock auth context; must be used under AuthProvider.
 * @returns Auth context value.
 * @throws When called outside AuthProvider.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
