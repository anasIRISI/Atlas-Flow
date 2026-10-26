import type { BuildWorkflowResponse, WorkflowNode } from '@flowforge/shared';
import { api } from './api';

export const buildWorkflow = (prompt: string) => api<BuildWorkflowResponse>('/ai/build-workflow', { method: 'POST', body: { prompt } });

export interface MissingCredential {
  node: string;
  credentialType: string;
  displayName: string;
}

export const fetchMissingCredentials = (nodes: WorkflowNode[]) =>
  api<{ missing: MissingCredential[] }>('/credentials/missing', {
    method: 'POST',
    body: { nodes: nodes.map((n) => ({ name: n.name, type: n.type, parameters: n.parameters, credentials: n.credentials, disabled: n.disabled })) },
  });
