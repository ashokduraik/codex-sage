import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { AuthProvider } from '@/features/auth/AuthContext';
import { queryClientInstance } from '@/shared/lib/query-client';
import { AppDataProvider } from '@/shared/mock-data';
import { Toaster } from '@/shared/ui/sonner';

interface ProvidersProps {
  children: ReactNode;
}

/**
 * Root provider tree: auth, mock app data, React Query, and toast host.
 * Must be rendered inside a Router because AuthProvider uses navigation.
 *
 * @param props - Provider children.
 * @returns Nested providers wrapping children.
 */
export function Providers({ children }: ProvidersProps) {
  return (
    <AuthProvider>
      <AppDataProvider>
        <QueryClientProvider client={queryClientInstance}>
          {children}
          <Toaster />
        </QueryClientProvider>
      </AppDataProvider>
    </AuthProvider>
  );
}
