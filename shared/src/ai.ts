import type { Connections, WorkflowNode } from './workflow.js';

/** POST /api/ai/build-workflow */
export interface BuildWorkflowRequest {
  prompt: string;
}

export interface BuildWorkflowResponse {
  /** Always valid and runnable: every node type exists, connections are checked, there is a trigger. */
  workflow: { name: string; nodes: WorkflowNode[]; connections: Connections };
  /** "ai" = written by Gemini for this prompt. "offline" = the closest ready-made template. */
  source: 'ai' | 'offline';
  /** Shown next to the result, e.g. "Built with Gemini" or "Offline: closest template". */
  label: string;
  /** Offline only: why Gemini was not used (no key, rate limit, invalid answer…). Never contains a secret. */
  reason?: string;
  /** Short hints for the user (what to configure next). */
  notes: string[];
  /** Offline only: the template that was picked. `weak` = the prompt matched it badly. */
  template?: { id: string; name: string; score: number; weak: boolean };
  /** Nodes whose credential is not configured yet (the editor shows a warning badge on them). */
  missingCredentials: { node: string; credentialType: string; displayName: string }[];
  /** Node names in the order the editor draws them (triggers first, sub-nodes right after their parent). */
  order: string[];
}

/** The six suggestions shown under the builder bar. Each one has a matching offline template (tested). */
export const BUILDER_SUGGESTIONS = [
  'Email me the weather every morning',
  'Contact form that posts to Discord and emails a confirmation',
  'Telegram bot that answers /weather with the forecast',
  'Website chatbot answered by Gemini',
  'AI assistant on Telegram that can check the weather',
  'Alert me on Discord when a website is down',
] as const;
