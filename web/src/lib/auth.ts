import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthStatus, LoginRequest, PublicUser, SetupRequest } from '@flowforge/shared';
import { api } from './api';
import { wsClient } from './ws';

export const AUTH_STATUS_KEY = ['auth', 'status'] as const;

export function useAuthStatus() {
  return useQuery({
    queryKey: AUTH_STATUS_KEY,
    queryFn: () => api<AuthStatus>('/auth/status'),
    staleTime: 60_000,
    retry: 1,
  });
}

function useSetSignedIn() {
  const client = useQueryClient();
  return (user: PublicUser) => client.setQueryData<AuthStatus>(AUTH_STATUS_KEY, { setupRequired: false, user });
}

export function useSetupOwner() {
  const setSignedIn = useSetSignedIn();
  return useMutation({
    mutationFn: (body: SetupRequest) => api<{ user: PublicUser }>('/auth/setup', { method: 'POST', body }),
    onSuccess: ({ user }) => setSignedIn(user),
  });
}

export function useLogin() {
  const setSignedIn = useSetSignedIn();
  return useMutation({
    mutationFn: (body: LoginRequest) => api<{ user: PublicUser }>('/auth/login', { method: 'POST', body }),
    onSuccess: ({ user }) => setSignedIn(user),
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      wsClient.disconnect();
      // Keep the auth query (the route guards observe it) and drop everything else from the cache.
      client.setQueryData<AuthStatus>(AUTH_STATUS_KEY, { setupRequired: false, user: null });
      client.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_STATUS_KEY[0] });
    },
  });
}
