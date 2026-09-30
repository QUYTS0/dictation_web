"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AuthProvider } from "@/context/auth";
import { NavigationFlushObserver } from "@/components/NavigationFlushObserver";
import { practiceFlushCoordinator } from "@/lib/practiceFlushCoordinator";

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            retry: 1,
          },
        },
      })
  );

  // The flush coordinator lives as long as the app, like this QueryClient.
  useEffect(() => {
    practiceFlushCoordinator.setQueryClient(queryClient);
    return () => practiceFlushCoordinator.setQueryClient(null);
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <NavigationFlushObserver />
        {children}
      </AuthProvider>
    </QueryClientProvider>
  );
}
