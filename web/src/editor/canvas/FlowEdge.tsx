import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Item } from '@flowforge/shared';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { plural } from '../../lib/format';
import type { EdgeRef } from '../graph';
import { editor, isRunning, useEditor } from '../store';
import { particleBudget, particleCount } from '../live';
import { PreviewBubble } from './PreviewBubble';

const PARTICLE_MS = 850;
const STAGGER_MS = 90;

/** One dot travelling along the edge. SVG animations are started explicitly when mounted. */
function Particle({ path, delay }: { path: string; delay: number }) {
  const motion = useRef<SVGAnimateMotionElement>(null);
  const fade = useRef<SVGAnimateElement>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      motion.current?.beginElement();
      fade.current?.beginElement();
    }, delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <circle r={3.5} fill="#ff8757" opacity={0} className="ff-particle">
      <animateMotion ref={motion} dur={`${PARTICLE_MS}ms`} begin="indefinite" fill="remove" path={path} />
      <animate ref={fade} attributeName="opacity" values="0;1;1;0" dur={`${PARTICLE_MS}ms`} begin="indefinite" fill="remove" />
    </circle>
  );
}

/** A burst of particles (1 per item, max 8) drawn from the global budget and removed when done. */
function Burst({ path, items }: { path: string; items: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const granted = particleBudget.acquire(particleCount(items));
    setN(granted);
    const t = setTimeout(() => {
      particleBudget.release(granted);
      setN(0);
    }, PARTICLE_MS + granted * STAGGER_MS + 60);
    return () => {
      clearTimeout(t);
      particleBudget.release(granted);
    };
  }, [items]);
  if (!n) return null;
  return (
    <g>
      {Array.from({ length: n }).map((_, i) => (
        <Particle key={i} path={path} delay={i * STAGGER_MS} />
      ))}
    </g>
  );
}

export const FlowEdge = memo(function FlowEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data } = props;
  const ref = (data as { ref?: EdgeRef; key?: string; error?: boolean } | undefined) ?? {};
  const live = useEditor((s) => (ref.key ? s.execution.edges[ref.key] : undefined));
  const running = useEditor((s) => isRunning(s.execution.status));
  const isError = ref.error === true;
  // AI connections (sub-node → slot) carry no items: they are drawn dashed and never show a count.
  const isAi = Boolean(ref.ref?.type && ref.ref.type !== 'main');
  const fresh = useEditor((s) => (ref.key ? s.fresh.includes(ref.key) : false));
  const [preview, setPreview] = useState<Item[] | null>(null);
  const onEnter = useCallback(() => {
    const r = ref.ref;
    if (!r || isAi) return;
    const run = useEditor.getState().runData?.[r.source]?.at(-1);
    setPreview(run?.data?.main?.[r.output] ?? []);
  }, [ref.ref, isAi]);
  const onLeave = useCallback(() => setPreview(null), []);
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const stroke = selected ? 'var(--color-accent)' : live?.count ? 'var(--color-success)' : isError ? 'rgba(240,82,79,0.7)' : isAi ? '#8b7fd1' : '#5b5b69';

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        // Freshly built edges draw themselves (stroke-dashoffset animation on a normalized path length).
        {...(fresh ? { pathLength: 1, className: 'ff-edge-draw' } : {})}
        style={{ stroke, strokeWidth: selected ? 2.5 : 2, ...(isAi && !fresh ? { strokeDasharray: '6 5' } : {}) }}
        interactionWidth={18}
      />
      {running && live && live.key > 0 && <Burst key={live.key} path={path} items={live.count} />}
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {live && live.count > 0 && (
            <span className="relative" onMouseEnter={onEnter} onMouseLeave={onLeave}>
              <span className="rounded-full bg-panel px-1.5 text-[10.5px] font-medium text-success" data-testid="edge-count">
                {plural(live.count, 'item')}
              </span>
              {preview && <PreviewBubble items={preview} title={`${ref.ref?.source} output`} className="bottom-full left-1/2 mb-1.5 -translate-x-1/2" />}
            </span>
          )}
          {selected && ref.ref && (
            <button
              type="button"
              title="Delete connection"
              data-testid="edge-delete"
              onClick={() => editor.disconnect([ref.ref!])}
              className="rounded border border-line-strong bg-panel-3 p-1 text-muted hover:border-danger hover:text-danger"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
