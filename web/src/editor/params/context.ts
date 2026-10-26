import { createContext, useContext } from 'react';
import type { Item, TaskSource } from '@flowforge/shared';
import type { CompletionData } from './cm';

/** Data around the node being edited: used by expression previews, autocomplete and drag & drop. */
export interface NodeEditContext {
  nodeName: string;
  inputItems: Item[];
  source: (TaskSource | null)[];
  completion: CompletionData;
}

export const NodeEditCtx = createContext<NodeEditContext>({ nodeName: '', inputItems: [], source: [], completion: { nodes: {} } });

export const useNodeEdit = () => useContext(NodeEditCtx);
