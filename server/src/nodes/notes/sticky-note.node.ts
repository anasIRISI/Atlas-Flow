import { defineNode } from '../../engine/types.js';

export default defineNode({
  description: {
    type: 'flowforge.stickyNote',
    displayName: 'Sticky Note',
    description: 'A note on the canvas (Markdown). It is never executed.',
    icon: 'lucide:sticky-note',
    group: 'note',
    version: 1,
    defaults: { name: 'Sticky Note', color: '#ffd233' },
    inputs: [],
    outputs: [],
    keywords: ['note', 'comment', 'markdown'],
  },
  properties: [
    { name: 'content', displayName: 'Content', type: 'string', default: '## Note\nDouble-click to edit', typeOptions: { rows: 6 } },
    { name: 'height', displayName: 'Height', type: 'number', default: 160 },
    { name: 'width', displayName: 'Width', type: 'number', default: 240 },
    { name: 'color', displayName: 'Color', type: 'number', default: 1 },
  ],
});
