import { Toaster } from '@/shared/ui/sonner';
import { AppDataProvider } from '@/shared/mock-data';
import { AuthProvider } from '@/features/auth/AuthContext';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/shared/lib/query-client';

/**
 * Root provider tree: React Query, auth, mock app data, and toast host.
 * Must be rendered inside a Router because AuthProvider uses navigation.
 *
 * @param props - Provider children.
 * @returns Nested providers wrapping children.
 */
export function Providers({ children }) {
  return (
    <QueryClientProvider client={queryClientInstance}>
      <AuthProvider>
        <AppDataProvider>
          {children}
          <Toaster />
        </AppDataProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
