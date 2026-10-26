import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useReactFlow } from '@xyflow/react';
import type { NodeTypeInfo } from '@flowforge/shared';
import { fetchMissingCredentials } from '../lib/ai-api';
import { credentialsKey } from '../lib/credentials-api';
import { wsClient, useWsStore } from '../lib/ws';
import { completeExecution, executeWorkflow, save } from './actions';
import { addSticky } from './canvas/Canvas';
import { editor, isRunning, useEditor } from './store';

/** Follows runs of this workflow over WebSocket; falls back to polling on gaps or a lost connection. */
export function useLiveExecution(workflowId: string | null) {
  const wsStatus = useWsStore((s) => s.status);
  const executionId = useEditor((s) => s.execution.id);
  const status = useEditor((s) => s.execution.status);

  useEffect(() => {
    if (!workflowId) return;
    const unsubscribe = wsClient.subscribe(`workflow:${workflowId}`);
    const off = wsClient.onEvent((event) => {
      const action = editor.applyEvent(event);
      const id = useEditor.getState().execution.id;
      if (action === 'finished' && id) void completeExecution(id);
      if (action === 'refetch' && id) void completeExecution(id);
    });
    return () => {
      off();
      unsubscribe();
    };
  }, [workflowId]);

  // Missed events (reconnect, gap in seq, WebSocket down): ask the server until the run is over.
  useEffect(() => {
    if (!executionId || !isRunning(status)) return;
    const timer = setInterval(() => {
      const s = useEditor.getState().execution;
      if (s.id && isRunning(s.status)) void completeExecution(s.id);
    }, wsStatus === 'open' ? 3000 : 1000);
    return () => clearInterval(timer);
  }, [executionId, status, wsStatus]);
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || Boolean(el.closest('.cm-editor'));
}

const selectedNames = () => {
  const s = useEditor.getState();
  return s.nodes.filter((n) => s.selected.includes(n.id)).map((n) => n.name);
};

/** Editor keyboard shortcuts (documented in the shortcuts dialog). */
export function useEditorShortcuts(types: Map<string, NodeTypeInfo>) {
  const rf = useReactFlow();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const s = useEditor.getState();
      if (mod && key === 's') {
        e.preventDefault();
        void save();
        return;
      }
      if (mod && key === 'k') {
        e.preventDefault();
        editor.setUi({ paletteOpen: !s.paletteOpen });
        return;
      }
      if (isTyping(e.target) || s.openNode || s.paletteOpen) return;
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        editor.redo();
      } else if (mod && key === 'c') {
        const text = editor.copy(selectedNames());
        if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
      } else if (mod && key === 'd') {
        e.preventDefault();
        editor.duplicate(selectedNames());
      } else if (mod && key === 'a') {
        e.preventDefault();
        editor.selectAll();
      } else if (mod && key === 'enter') {
        e.preventDefault();
        void executeWorkflow();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        editor.openCreator();
      } else if (e.shiftKey && e.altKey && key === 't') {
        e.preventDefault();
        editor.layout((n) => n.type === 'flowforge.stickyNote');
        setTimeout(() => void rf.fitView({ padding: 0.25, maxZoom: 1, duration: 300 }), 50);
      } else if (e.shiftKey && key === 's') {
        e.preventDefault();
        addSticky(types, rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
      } else if (e.shiftKey && e.key === '!') {
        void rf.fitView({ padding: 0.25, maxZoom: 1, duration: 300 });
      } else if (!mod && key === 'd') {
        editor.toggleDisabled(selectedNames());
      } else if (e.key === 'Enter') {
        const names = selectedNames();
        if (names.length === 1 && s.nodes.find((n) => n.name === names[0])?.type !== 'flowforge.stickyNote') editor.openPanel(names[0]!);
      } else if (e.key === '?') {
        editor.setUi({ helpOpen: true });
      } else if (e.key === 'Escape') {
        editor.closeCreator();
        editor.setUi({ helpOpen: false });
      }
    };
    // Paste works through the clipboard event (also on http:// LAN addresses where the Clipboard API is blocked).
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e.target) || useEditor.getState().openNode) return;
      const text = e.clipboardData?.getData('text/plain') ?? null;
      const pasted = text ? editor.paste(text) : 0;
      if (!pasted) editor.paste(null);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [rf, types]);
}

/**
 * Keeps the "credential missing" badges of the canvas up to date: asks the server which nodes still need a
 * credential whenever the nodes (type, selected credential, authentication) or the saved credentials change.
 */
export function useMissingCredentials() {
  const signature = useEditor((s) =>
    JSON.stringify(s.nodes.map((n) => [n.name, n.type, n.credentials ?? null, n.disabled ?? false, (n.parameters as { authentication?: unknown }).authentication ?? null])),
  );
  // The signature changes on every keystroke of a rename: wait until it is stable.
  const [stable, setStable] = useState(signature);
  useEffect(() => {
    const timer = setTimeout(() => setStable(signature), 400);
    return () => clearTimeout(timer);
  }, [signature]);
  const query = useQuery({
    queryKey: [...credentialsKey, 'missing', stable],
    queryFn: () => fetchMissingCredentials(useEditor.getState().nodes),
    staleTime: 15_000,
  });
  useEffect(() => {
    if (!query.data) return;
    const map: Record<string, string[]> = {};
    for (const m of query.data.missing) (map[m.node] ??= []).push(m.displayName);
    editor.setMissingCredentials(map);
  }, [query.data]);
}
