import { createContext, useContext } from 'react';
import type { NodeTypeInfo } from '@flowforge/shared';

export const NodeTypesCtx = createContext<Map<string, NodeTypeInfo>>(new Map());
export const useNodeTypeMap = () => useContext(NodeTypesCtx);
