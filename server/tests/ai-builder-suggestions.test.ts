import { describe, expect, it } from 'vitest';
import { BUILDER_SUGGESTIONS } from '@flowforge/shared';
import { EXAMPLES_DIR } from '../src/api/examples.js';
import { loadTemplates, rankTemplates } from '../src/ai/builder/fallback.js';
import { getTestRegistry } from './engine-helpers.js';

// The six chips under the builder bar must give a sensible result without a Gemini key.
const EXPECTED: Record<string, string[]> = {
  'Email me the weather every morning': ['daily-weather-email'],
  'Contact form that posts to Discord and emails a confirmation': ['contact-form-discord'],
  'Telegram bot that answers /weather with the forecast': ['telegram-assistant'],
  'Website chatbot answered by Gemini': ['website-chatbot', 'website-chatbot-agent'],
  'AI assistant on Telegram that can check the weather': ['telegram-ai-assistant'],
  'Alert me on Discord when a website is down': ['builtin-website-down-alert'],
};

describe('builder suggestions offline', () => {
  it('each of the six suggestions picks its template, and not as a weak match', async () => {
    const templates = loadTemplates(EXAMPLES_DIR, await getTestRegistry());
    expect(BUILDER_SUGGESTIONS).toHaveLength(6);
    const rows = BUILDER_SUGGESTIONS.map((prompt) => {
      const [best] = rankTemplates(prompt, templates);
      return { prompt, template: best!.template.id, score: Number(best!.score.toFixed(3)), weak: best!.weak };
    });
    for (const row of rows) {
      expect(EXPECTED[row.prompt], row.prompt).toContain(row.template);
      expect(row.weak, row.prompt).toBe(false);
    }
  });
});
