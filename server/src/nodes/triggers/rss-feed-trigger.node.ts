import Parser from 'rss-parser';
import type { Item } from '@flowforge/shared';
import { NodeOperationError } from '../../engine/errors.js';
import { defineNode } from '../../engine/types.js';
import { dedupe } from '../../triggers/dedupe.js';
import { assertHttpUrl, fetchWithTimeout } from '../_shared/http.js';

const parser = new Parser();

export default defineNode({
  description: {
    type: 'flowforge.rssFeedTrigger',
    displayName: 'RSS Feed Trigger',
    description: 'Starts the workflow when new items appear in an RSS or Atom feed.',
    icon: 'lucide:rss',
    group: 'trigger',
    version: 1,
    defaults: { name: 'RSS Feed Trigger', color: '#f78c40' },
    subtitle: 'every {{pollInterval}} {{pollUnit}}',
    inputs: [],
    outputs: [{ type: 'main' }],
    trigger: { kind: 'poll' },
    keywords: ['feed', 'atom', 'news', 'blog', 'podcast'],
  },
  properties: [
    { name: 'feedUrl', displayName: 'Feed URL', type: 'string', default: '', placeholder: 'https://example.com/feed.xml', required: true },
    { name: 'pollInterval', displayName: 'Check Every', type: 'number', default: 5, typeOptions: { minValue: 1 } },
    {
      name: 'pollUnit',
      displayName: 'Unit',
      type: 'options',
      default: 'minutes',
      options: [
        { name: 'Seconds', value: 'seconds' },
        { name: 'Minutes', value: 'minutes' },
        { name: 'Hours', value: 'hours' },
      ],
    },
    {
      name: 'options',
      displayName: 'Options',
      type: 'collection',
      default: {},
      placeholder: 'Add option',
      options: [
        {
          name: 'emitExistingOnFirstRun',
          displayName: 'Emit Existing Items on First Check',
          type: 'boolean',
          default: false,
          description: 'Off = the first check only remembers what is already in the feed.',
        },
      ],
    },
  ],
  validate(ctx) {
    assertHttpUrl(String(ctx.getNodeParameter('feedUrl', '') ?? ''));
  },
  async poll(ctx) {
    const url = String(ctx.getNodeParameter('feedUrl', '') ?? '');
    assertHttpUrl(url);
    const xml = await (await fetchWithTimeout(url, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } })).text();
    let feed;
    try {
      feed = await parser.parseString(xml);
    } catch (err) {
      throw new NodeOperationError('This URL does not return a valid RSS/Atom feed', { description: (err as Error).message });
    }
    const items: Item[] = (feed.items ?? []).map((i) => ({ json: JSON.parse(JSON.stringify(i)) as Item['json'] }));
    // Test event: the newest item. Active workflow: only items not seen before.
    if (ctx.mode === 'manual') return items.slice(0, 1);
    return dedupe(ctx.getStaticData(), items, {
      key: 'guid',
      emitExistingOnFirstRun: ctx.getNodeParameter<boolean>('options.emitExistingOnFirstRun', false),
    });
  },
});
