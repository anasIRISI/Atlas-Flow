import type { ChatMemoryStore, ChatTurn } from '../../engine/types.js';
import type { DB } from '../index.js';

const MAX_CONTENT_CHARS = 20_000;
const MAX_TURNS_PER_SESSION = 200;

/** Conversation history of chat sessions (Chat Trigger → AI nodes). */
export class ChatMemoryRepo implements ChatMemoryStore {
  constructor(private readonly db: DB) {}

  load(sessionKey: string, limit: number): ChatTurn[] {
    const rows = this.db
      .prepare('SELECT role, content FROM chat_memory WHERE session_key = ? ORDER BY id DESC LIMIT ?')
      .all(sessionKey, Math.max(0, Math.min(Math.trunc(limit) || 0, MAX_TURNS_PER_SESSION))) as { role: string; content: string }[];
    return rows.reverse().map((r) => ({ role: r.role === 'model' ? 'model' : 'user', text: r.content }));
  }

  append(sessionKey: string, turns: ChatTurn[]): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare('INSERT INTO chat_memory (session_key, role, content, created_at) VALUES (?, ?, ?, ?)');
    for (const turn of turns) insert.run(sessionKey, turn.role, turn.text.slice(0, MAX_CONTENT_CHARS), now);
    // Keep sessions bounded: drop everything older than the newest MAX_TURNS_PER_SESSION messages.
    this.db
      .prepare('DELETE FROM chat_memory WHERE session_key = ? AND id NOT IN (SELECT id FROM chat_memory WHERE session_key = ? ORDER BY id DESC LIMIT ?)')
      .run(sessionKey, sessionKey, MAX_TURNS_PER_SESSION);
  }

  clear(sessionKey: string): void {
    this.db.prepare('DELETE FROM chat_memory WHERE session_key = ?').run(sessionKey);
  }

  count(sessionKey: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM chat_memory WHERE session_key = ?').get(sessionKey) as { n: number }).n;
  }
}
