import { QueryClient } from '@tanstack/react-query';

/** Shared React Query client with app-wide defaults. */
export const queryClientInstance = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
