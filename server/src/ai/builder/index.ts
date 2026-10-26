// AI Workflow Builder: prompt → catalog → Gemini (JSON) → validation (one repair retry) → layout. When Gemini cannot
// be used, or its answer stays invalid, the closest ready-made template is returned instead (clearly labelled).
// The response ALWAYS holds a valid, runnable workflow whose node types all exist in the registry.
// Gemini API: https://ai.google.dev/api/generate-content (client: server/src/integrations/gemini.ts)
import type { BuildWorkflowResponse, WorkflowNode } from '@flowforge/shared';
import { activeCredentialTypes } from '../../credentials/check.js';
import { MissingCredentialError, NodeOperationError } from '../../engine/errors.js';
import type { CredentialsProvider } from '../../engine/types.js';
import { IntegrationError } from '../../integrations/errors.js';
import { GEMINI_DEFAULT_MODEL, generateContent, type GeminiRequest } from '../../integrations/gemini.js';
import type { Logger } from '../../logger.js';
import type { NodeRegistry } from '../../nodes/registry.js';
import { buildCatalog, type Catalog } from './catalog.js';
import { loadTemplates, rankTemplates } from './fallback.js';
import { layoutNodes, subNodesByParent } from './layout.js';
import { buildPrompt, buildRetryPrompt } from './prompt.js';
import { validateWorkflow, type ValidateContext, type ValidationResult, type ValidWorkflow } from './validate.js';

export const AI_LABEL = 'Built with Gemini';
export const OFFLINE_LABEL = 'Offline: closest template';
export const GEMINI_TIMEOUT_MS = 45_000;
const CREDENTIAL_TYPE = 'googlePalmApi';
const INVALID_REASON = "Gemini's answer was not a valid workflow";

export interface BuilderDeps {
  registry: NodeRegistry;
  credentials: CredentialsProvider;
  examplesDir: string;
  logger: Logger;
  /** Tests only: list hidden test nodes in the catalog. */
  includeHidden?: boolean;
  /** Timeout of one Gemini call (default 45 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The validator must never take the request down: an unexpected exception is reported like any other problem. */
function check(raw: unknown, ctx: ValidateContext): ValidationResult {
  try {
    return validateWorkflow(raw, ctx);
  } catch (err) {
    return { errors: [`The workflow could not be checked (${err instanceof Error ? err.message : 'unknown error'})`] };
  }
}

type GeminiOutcome = { workflow: ValidWorkflow } | { reason: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Plain-words reason for a failed Gemini call. Never contains the key (client messages are redacted already). */
export function describeGeminiFailure(err: unknown, apiKey = ''): string {
  if (err instanceof IntegrationError) {
    if (err.status === 429) return "Gemini's rate limit was reached (the free tier allows a few requests per minute). Try again in a minute.";
    if (err.status !== undefined && err.status >= 500) return 'Gemini is unavailable right now (a problem on Google\'s side).';
    if (err.auth) return 'Gemini rejected the API key. Check the Google Gemini API credential.';
    if (/block|safety|stopped the answer/i.test(err.message)) return 'Gemini refused the request (safety filter).';
    if (err.status === 404) return 'The Gemini model of the credential was not found.';
    const text = apiKey ? err.message.split(apiKey).join('***') : err.message;
    return `Gemini could not answer: ${clip(text, 160)}`;
  }
  if (err instanceof NodeOperationError && /No answer from/i.test(err.message)) return 'Gemini did not answer in time.';
  return 'Gemini could not be reached.';
}

/** A JSON-mode answer that was not JSON: the client throws before we see the text, only its start is in the hint. */
function badJsonAnswer(err: unknown): string | undefined {
  if (!(err instanceof IntegrationError) || err.status !== undefined || !/valid JSON/i.test(err.message)) return undefined;
  const start = /Start of the answer: ([\s\S]*?)(?:\. Ask for JSON explicitly|$)/.exec(err.hint ?? '');
  return start?.[1] ?? '';
}

async function askGemini(text: string, catalog: Catalog, ctx: ValidateContext, deps: BuilderDeps): Promise<GeminiOutcome> {
  let credential;
  try {
    credential = deps.credentials.resolve({ name: 'AI Workflow Builder' } as WorkflowNode, CREDENTIAL_TYPE);
  } catch (err) {
    return {
      reason:
        err instanceof MissingCredentialError
          ? 'No Google Gemini API key is set up yet (add a "Google Gemini API" credential or set GEMINI_API_KEY in .env).'
          : 'The Google Gemini credential cannot be used. Open Credentials and check it.',
    };
  }
  const apiKey = String(credential.data.apiKey ?? '').trim();
  if (!apiKey) return { reason: 'The Google Gemini credential has no API key.' };
  const auth = { apiKey, host: String(credential.data.host ?? '').trim() || undefined };
  const model = String(credential.data.model ?? '').trim() || GEMINI_DEFAULT_MODEL;

  const call = (request: Omit<GeminiRequest, 'model'>) =>
    generateContent(auth, { ...request, model, json: true, temperature: 0.2, maxRetries: 1 }, { timeoutMs: deps.timeoutMs ?? GEMINI_TIMEOUT_MS, signal: deps.signal });

  let request: Omit<GeminiRequest, 'model'> = buildPrompt(catalog, text);
  for (let attempt = 1; attempt <= 2; attempt++) {
    let answer: string;
    let errors: string[];
    try {
      const result = await call(request);
      answer = result.text;
      const checked = check(result.json, ctx);
      if (checked.workflow) return { workflow: checked.workflow };
      errors = checked.errors;
    } catch (err) {
      const partial = badJsonAnswer(err);
      if (partial === undefined) return { reason: describeGeminiFailure(err, apiKey) };
      answer = partial;
      errors = ['The answer is not valid JSON. Reply with one JSON object only: no markdown fence, no text around it, no comments, double quotes everywhere.'];
    }
    deps.logger.debug(`AI Workflow Builder: attempt ${attempt} was not a valid workflow (${errors.length} problem(s))`);
    if (attempt === 2) break;
    request = buildRetryPrompt(catalog, text, answer, errors);
  }
  return { reason: INVALID_REASON };
}

// ── response ────────────────────────────────────────────────────────────────

/** Triggers first, then the main flow (breadth first), each sub-node right after its parent. */
export function nodeOrder(workflow: ValidWorkflow, registry: NodeRegistry): string[] {
  const subs = subNodesByParent(workflow.nodes, workflow.connections);
  const subNames = new Set([...subs.values()].flat());
  const isTrigger = (n: WorkflowNode) => registry.get(n.type)?.description.group === 'trigger' || registry.get(n.type)?.description.trigger !== undefined;
  const mains = workflow.nodes.filter((n) => !subNames.has(n.name));
  const order: string[] = [];
  const seen = new Set<string>();
  const emit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    order.push(name);
    for (const sub of subs.get(name) ?? []) if (!seen.has(sub)) (seen.add(sub), order.push(sub));
  };
  const triggers = mains.filter(isTrigger);
  triggers.forEach((t) => emit(t.name));
  const queue = triggers.map((t) => t.name);
  while (queue.length) {
    const from = queue.shift()!;
    for (const list of workflow.connections[from]?.main ?? []) {
      for (const target of list) {
        if (seen.has(target.node) || subNames.has(target.node)) continue;
        emit(target.node);
        queue.push(target.node);
      }
    }
  }
  mains.forEach((n) => emit(n.name)); // anything left (cannot happen after validation)
  return order;
}

function missingCredentials(workflow: ValidWorkflow, deps: BuilderDeps): BuildWorkflowResponse['missingCredentials'] {
  const out: BuildWorkflowResponse['missingCredentials'] = [];
  for (const node of workflow.nodes) {
    const type = deps.registry.get(node.type);
    if (!type) continue;
    for (const credentialType of activeCredentialTypes(node, type)) {
      try {
        deps.credentials.resolve(node, credentialType);
      } catch (err) {
        const displayName = err instanceof MissingCredentialError ? err.message.replace(/ credentials are missing$/, '') : credentialType;
        out.push({ node: node.name, credentialType, displayName });
      }
    }
  }
  return out;
}

function respond(workflow: ValidWorkflow, base: Pick<BuildWorkflowResponse, 'source' | 'label' | 'reason' | 'template'>, extraNotes: string[], deps: BuilderDeps): BuildWorkflowResponse {
  layoutNodes(workflow.nodes, workflow.connections);
  const missing = missingCredentials(workflow, deps);
  const notes = [...extraNotes, ...workflow.notes, ...missing.map((m) => `"${m.node}" needs a ${m.displayName} credential: add it on the Credentials page before running.`)];
  const response: BuildWorkflowResponse = {
    workflow: { name: workflow.name, nodes: workflow.nodes, connections: workflow.connections },
    source: base.source,
    label: base.label,
    notes,
    missingCredentials: missing,
    order: nodeOrder(workflow, deps.registry),
  };
  if (base.reason !== undefined) response.reason = base.reason;
  if (base.template) response.template = base.template;
  return response;
}

function offline(text: string, reason: string, ctx: ValidateContext, deps: BuilderDeps): BuildWorkflowResponse {
  const ranked = rankTemplates(text, loadTemplates(deps.examplesDir, deps.registry));
  for (const { template, score, weak } of ranked) {
    // A template goes through the same validation as an AI answer: never trust a file blindly.
    const checked = check(template.workflow, ctx);
    if (!checked.workflow) {
      deps.logger.warn(`AI Workflow Builder: template "${template.id}" skipped (${checked.errors[0] ?? 'invalid'})`);
      continue;
    }
    const notes = ['Offline mode: this is the closest ready-made template, not a workflow written for your request.'];
    if (weak) notes.push('It matches your request only loosely: use it as a starting point and adapt the nodes.');
    return respond(checked.workflow, { source: 'offline', label: OFFLINE_LABEL, reason, template: { id: template.id, name: template.name, score, weak } }, notes, deps);
  }
  throw new Error('AI Workflow Builder: no valid offline template is available');
}

/** Never throws for a Gemini problem: the answer is the AI workflow or the closest offline template. */
export async function buildWorkflow(prompt: string, deps: BuilderDeps): Promise<BuildWorkflowResponse> {
  const text = prompt.trim();
  const catalog = buildCatalog(deps.registry, { includeHidden: deps.includeHidden });
  const ctx: ValidateContext = { registry: deps.registry, catalog };

  const outcome = await askGemini(text, catalog, ctx, deps);
  if ('workflow' in outcome) {
    deps.logger.info(`AI Workflow Builder: Gemini built a workflow with ${outcome.workflow.nodes.length} node(s)`);
    return respond(outcome.workflow, { source: 'ai', label: AI_LABEL }, [], deps);
  }
  deps.logger.warn(`AI Workflow Builder: offline fallback (${outcome.reason})`);
  return offline(text, outcome.reason, ctx, deps);
}
