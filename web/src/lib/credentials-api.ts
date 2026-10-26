import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CredentialInput, CredentialSummary, CredentialTestRequest, CredentialTestResult, CredentialTypeInfo } from '@flowforge/shared';
import { api } from './api';

export const credentialsKey = ['credentials'] as const;
export const credentialTypesKey = ['credential-types'] as const;

export function useCredentialTypes() {
  return useQuery({ queryKey: credentialTypesKey, queryFn: () => api<CredentialTypeInfo[]>('/credential-types'), staleTime: 60_000 });
}

export function useCredentials() {
  return useQuery({ queryKey: credentialsKey, queryFn: () => api<CredentialSummary[]>('/credentials') });
}

/** Creates (no id) or updates a credential. */
export function useSaveCredential() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: Partial<CredentialInput> & { id?: string }) =>
      id ? api<CredentialSummary>(`/credentials/${id}`, { method: 'PATCH', body }) : api<CredentialSummary>('/credentials', { method: 'POST', body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: credentialsKey }),
  });
}

export function useDeleteCredential() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/credentials/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: credentialsKey }),
  });
}

export const testCredential = (body: CredentialTestRequest) => api<CredentialTestResult>('/credentials/test', { method: 'POST', body });

/** Tests the values found in `.env` for this type. */
export const testEnvCredential = (type: string) => api<CredentialTestResult>(`/credentials/env/test?type=${encodeURIComponent(type)}`, { method: 'POST' });
