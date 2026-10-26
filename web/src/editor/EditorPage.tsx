import { useEffect, useMemo } from 'react';
import { useBlocker, useParams, useSearchParams } from 'react-router';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FullScreenError, FullScreenLoader } from '../components/FullScreen';
import type { ExecutionDetail } from '@flowforge/shared';
import { api, errorMessage } from '../lib/api';
import { fetchExecutions } from '../lib/executions-api';
import { wsClient } from '../lib/ws';
import { useNodeTypes } from '../lib/node-types';
import { useTitle } from '../lib/useTitle';
import { useWorkflow } from '../lib/workflows-api';
import { setNodeTypes } from './actions';
import { addSticky, Canvas } from './canvas/Canvas';
import { BuilderBar } from './BuilderBar';
import { ChatPanel } from './ChatPanel';
import { CommandPalette } from './CommandPalette';
import { NodeCreator } from './creator/NodeCreator';
import { useEditorShortcuts, useLiveExecution, useMissingCredentials } from './hooks';
import { ExecutionLog } from './log/ExecutionLog';
import { ExecutionTimeline } from './ExecutionTimeline';
import { TimeTravelBar } from './timetravel/TimeTravelBar';
import { DemoOverlay } from '../demo/DemoOverlay';
import { NodeDetailsView } from './ndv/NodeDetailsView';
import { ShortcutsDialog } from './ShortcutsDialog';
import { editor, useEditor } from './store';
import { TopBar } from './TopBar';
import { WorkflowSettingsDialog } from './WorkflowSettingsDialog';
import type { NodeTypeInfo } from '@flowforge/shared';

function EditorShell({ list, byType }: { list: NodeTypeInfo[]; byType: Map<string, NodeTypeInfo> }) {
  const workflowId = useEditor((s) => s.workflowId);
  const name = useEditor((s) => s.name);
  const dirty = useEditor((s) => s.dirty);
  const rf = useReactFlow();
  useTitle(name || 'Workflow');
  useEffect(() => setNodeTypes(byType), [byType]);
  useEffect(() => wsClient.connect(), []);
  useLiveExecution(workflowId);
  useEditorShortcuts(byType);
  useMissingCredentials();

  // Warn before closing the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => useEditor.getState().dirty && currentLocation.pathname !== nextLocation.pathname);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="relative min-h-0 flex-1">
        <Canvas types={byType} />
        <NodeCreator types={list} />
        <ChatPanel />
        <BuilderBar />
        <DemoOverlay />
      </div>
      <TimeTravelBar />
      <ExecutionTimeline />
      <ExecutionLog />
      <NodeDetailsView types={byType} />
      <CommandPalette
        types={list}
        onAutoLayout={() => {
          editor.layout((n) => n.type === 'flowforge.stickyNote');
          setTimeout(() => void rf.fitView({ padding: 0.25, maxZoom: 1, duration: 300 }), 50);
        }}
        onAddSticky={() => addSticky(byType, rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }))}
      />
      <ShortcutsDialog />
      <WorkflowSettingsDialog />
      {blocker.state === 'blocked' && (
        <ConfirmDialog
          title="Leave without saving?"
          message="You have unsaved changes in this workflow. They will be lost if you leave."
          confirmLabel="Leave without saving"
          danger
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        />
      )}
    </div>
  );
}

/** After a reload: colours, item counts and node outputs of the requested (or latest) execution come back. */
async function restoreLastRun(workflowId: string, executionId: string | null) {
  try {
    let wanted = executionId;
    if (!wanted) wanted = (await fetchExecutions({ workflowId, limit: 1 })).items[0]?.id ?? null;
    if (!wanted) return;
    const detail = await api<ExecutionDetail>(`/executions/${wanted}`);
    const state = useEditor.getState();
    // The user may have left, or started a run, while this was loading.
    if (state.workflowId !== workflowId || state.lastExecutionId || state.execution.id) return;
    if (['queued', 'running', 'waiting'].includes(detail.status)) return;
    if (detail.workflowId && detail.workflowId !== workflowId) return;
    const names = new Set(state.nodes.map((n) => n.name));
    const runData = Object.fromEntries(Object.entries(detail.runData).filter(([name]) => names.has(name)));
    editor.finishFromDetail({ ...detail, runData, events: detail.events.filter((ev) => names.has(ev.node)) });
  } catch {
    // Restoring is a convenience: the editor works without it.
  }
}

export function EditorPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const requestedExecution = search.get('execution');
  const replaying = search.get('replay') === '1';
  const workflow = useWorkflow(id);
  const nodeTypes = useNodeTypes();
  const loadedId = useEditor((s) => s.workflowId);

  useEffect(() => {
    if (workflow.data && workflow.data.id !== useEditor.getState().workflowId) {
      editor.load(workflow.data);
      // Time travel loads the execution itself (TimeTravelBar).
      if (!replaying) void restoreLastRun(workflow.data.id, requestedExecution);
    }
  }, [workflow.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => editor.reset(), []);

  const types = useMemo(() => nodeTypes.data, [nodeTypes.data]);
  if (workflow.isError) return <FullScreenError message={errorMessage(workflow.error)} onRetry={() => void workflow.refetch()} />;
  if (nodeTypes.isError) return <FullScreenError message={errorMessage(nodeTypes.error)} onRetry={() => void nodeTypes.refetch()} />;
  if (!workflow.data || !types || loadedId !== workflow.data.id) return <FullScreenLoader />;

  return (
    <ReactFlowProvider>
      <EditorShell list={types.list} byType={types.byType} />
    </ReactFlowProvider>
  );
}
