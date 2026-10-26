import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Play, X } from 'lucide-react';
import type { NodeTypeInfo } from '@flowforge/shared';
import { Button } from '../../components/ui/Button';
import { cn } from '../../components/ui/cn';
import { iconFor, isTriggerType, staticOutputs } from '../../lib/node-types';
import { toast } from '../../lib/toast';
import { executeStep } from '../actions';
import { NodeEditCtx, type NodeEditContext } from '../params/context';
import { isVisible, withDefaults } from '../params/display';
import { ParameterList } from '../params/ParameterList';
import { editor, isRunning, useEditor } from '../store';
import { inputFor, nodeSamples } from './data';
import { InputPanel, OutputPanel } from './DataPanel';
import { FormPreview } from './FormPreview';
import { NodeCredentials } from './NodeCredentials';
import { NodeSettings } from './NodeSettings';
import { TriggerPanel } from './TriggerPanel';

function NodeName({ name }: { name: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);
  const commit = () => {
    const error = editor.renameNode(name, draft);
    if (error) {
      toast.error('Cannot rename', error);
      setDraft(name);
    }
    setEditing(false);
  };
  return editing ? (
    <input
      autoFocus
      data-testid="ndv-name-input"
      className="h-8 min-w-0 rounded border border-accent bg-panel-2 px-2 text-[15px] font-semibold focus:outline-none"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(name);
          setEditing(false);
        }
      }}
    />
  ) : (
    <button type="button" data-testid="ndv-name" title="Rename" onClick={() => setEditing(true)} className="truncate rounded px-1 text-[15px] font-semibold hover:bg-panel-3">
      {name}
    </button>
  );
}

/** Node panel: INPUT | PARAMETERS / SETTINGS | OUTPUT. Opened by double-clicking a node. */
export function NodeDetailsView({ types }: { types: Map<string, NodeTypeInfo> }) {
  const openNode = useEditor((s) => s.openNode);
  const node = useEditor((s) => s.nodes.find((n) => n.name === s.openNode));
  const connections = useEditor((s) => s.connections);
  const runData = useEditor((s) => s.runData);
  const pinData = useEditor((s) => s.pinData);
  const dynamic = useEditor((s) => (node ? s.dynamicOutputs[node.id] : undefined));
  const running = useEditor((s) => isRunning(s.execution.status));
  const [tab, setTab] = useState<'parameters' | 'settings'>('parameters');
  const [inputIndex, setInputIndex] = useState(0);
  const [leftTab, setLeftTab] = useState<'input' | 'form'>('input');
  const type = node ? types.get(node.type) : undefined;
  // Nodes with a visible form builder (Form Trigger, Wait "On Form Submitted") get a live preview next to it.
  const defaults = useMemo(() => (type ? withDefaults(type.properties, {}) : {}), [type]);
  const hasForm = Boolean(
    node && type?.properties.some((p) => p.type === 'formFields' && isVisible(p, withDefaults(type.properties, node.parameters), node.parameters)),
  );
  useEffect(() => setLeftTab(hasForm ? 'form' : 'input'), [hasForm, openNode]);

  useEffect(() => {
    setTab('parameters');
    setInputIndex(0);
  }, [openNode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.cm-tooltip-autocomplete')) editor.openPanel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const input = useMemo(
    () => (node ? inputFor(node.name, inputIndex, connections, runData, pinData) : { items: [], source: [] }),
    [node, inputIndex, connections, runData, pinData],
  );
  const context: NodeEditContext = useMemo(
    () => ({
      nodeName: node?.name ?? '',
      inputItems: input.items,
      source: input.source,
      completion: { input: input.items[0]?.json, nodes: nodeSamples(runData, pinData) },
    }),
    [node?.name, input, runData, pinData],
  );

  if (!node) return null;
  const isTrigger = isTriggerType(type);
  const Icon = iconFor(type?.icon);
  const outputs = dynamic ?? staticOutputs(type, node);
  const inputLabels = (type?.inputs ?? []).map((inp, i) => inp.displayName ?? `Input ${i + 1}`);

  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" onMouseDown={(e) => e.target === e.currentTarget && editor.openPanel(null)}>
      <div
        className="absolute inset-x-[2.5%] inset-y-[3%] flex animate-fade-in flex-col overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl shadow-black/50"
        data-testid="ndv"
      >
        <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <button type="button" data-testid="ndv-back" onClick={() => editor.openPanel(null)} className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[12.5px] text-muted hover:bg-panel-3 hover:text-fg">
            <ArrowLeft size={15} /> Back to canvas
          </button>
          <div className="mx-2 h-5 w-px bg-line" />
          <Icon size={18} style={{ color: type?.defaults.color }} className="shrink-0" />
          <NodeName name={node.name} />
          {type && <span className="hidden truncate text-[12px] text-subtle md:inline">{type.displayName}</span>}
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" icon={<Play size={14} />} loading={running} onClick={() => executeStep(node.name)} data-testid="ndv-execute-step">
              {type?.type === 'flowforge.chatTrigger' ? 'Open chat' : isTrigger && ['webhook', 'listener'].includes(type?.trigger?.kind ?? '') ? 'Listen for test event' : isTrigger && type?.trigger?.kind !== 'manual' ? 'Fetch test event' : 'Execute step'}
            </Button>
            <button type="button" data-testid="ndv-close" onClick={() => editor.openPanel(null)} className="rounded p-1.5 text-subtle hover:bg-panel-3 hover:text-fg" title="Close (Esc)">
              <X size={16} />
            </button>
          </div>
        </header>
        {!type ? (
          <div className="p-6 text-danger">Unknown node type "{node.type}". The node cannot be edited in this version of FlowForge.</div>
        ) : (
          <NodeEditCtx.Provider value={context}>
            <div className={cn('grid min-h-0 flex-1', isTrigger && !hasForm ? 'grid-cols-[1.2fr_1fr]' : 'grid-cols-[1fr_1.15fr_1fr]')}>
              {isTrigger && hasForm && (
                <div className="flex min-h-0 flex-col border-r border-line">
                  <FormPreview parameters={node.parameters} defaults={defaults} />
                </div>
              )}
              {!isTrigger && (
                <div className="flex min-h-0 flex-col border-r border-line">
                  {hasForm && (
                    <div className="flex gap-1 border-b border-line px-3 pt-2">
                      {(['form', 'input'] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          data-testid={`ndv-left-${t}`}
                          onClick={() => setLeftTab(t)}
                          className={cn('-mb-px border-b-2 px-2 pb-2 text-[13px]', leftTab === t ? 'border-accent text-fg' : 'border-transparent text-subtle hover:text-fg')}
                        >
                          {t === 'form' ? 'Form preview' : 'Input'}
                        </button>
                      ))}
                    </div>
                  )}
                  {hasForm && leftTab === 'form' ? (
                    <FormPreview parameters={node.parameters} defaults={defaults} />
                  ) : (
                    <InputPanel items={input.items} fromNode={input.fromNode} inputLabels={inputLabels} inputIndex={inputIndex} onInputIndex={setInputIndex} />
                  )}
                </div>
              )}
              <section className="flex min-h-0 flex-col border-r border-line bg-panel-2/30" data-testid="parameters-panel">
                <div className="flex gap-1 border-b border-line px-3 pt-2">
                  {(['parameters', 'settings'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      data-testid={`ndv-tab-${t}`}
                      onClick={() => setTab(t)}
                      className={cn('-mb-px border-b-2 px-2 pb-2 text-[13px] capitalize', tab === t ? 'border-accent text-fg' : 'border-transparent text-subtle hover:text-fg')}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  {node.notes && tab === 'parameters' && (
                    <div className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12.5px] text-[#ffd99b]">{node.notes}</div>
                  )}
                  {tab === 'parameters' && <NodeCredentials node={node} type={type} />}
                  {tab === 'parameters' ? (
                    type.properties.length ? (
                      <ParameterList
                        properties={type.properties}
                        values={node.parameters}
                        root={node.parameters}
                        onChange={(values) => editor.updateParameters(node.name, values)}
                        testPrefix="param"
                      />
                    ) : (
                      <p className="text-[12.5px] text-subtle">This node has no parameters.</p>
                    )
                  ) : (
                    <NodeSettings node={node} isTrigger={isTrigger} />
                  )}
                </div>
              </section>
              <div className="flex min-h-0 flex-col">
                <OutputPanel
                  key={node.name}
                  emptyState={isTrigger && type.trigger?.kind !== 'manual' ? <TriggerPanel nodeName={node.name} type={type} /> : undefined}
                  runs={runData?.[node.name] ?? []}
                  outputs={outputs}
                  pinned={pinData[node.name]}
                  canPin={outputs.length > 0}
                  running={running}
                  onExecute={() => executeStep(node.name)}
                  onPin={(items) => {
                    editor.pin(node.name, items);
                    toast.info('Data pinned', 'Manual runs will use this output instead of executing the node.');
                  }}
                  onUnpin={() => editor.unpin(node.name)}
                />
              </div>
            </div>
          </NodeEditCtx.Provider>
        )}
      </div>
    </div>
  );
}
