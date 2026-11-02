// LLMProvider (not enabled in v1). Sends the dialogue request to a small server proxy that holds the API key
// and returns { text, action?, relationshipDelta?, moodDelta? } JSON. Falls back to another provider on error.
// To enable later: deploy the proxy, then in main.ts use `new LLMProvider('/api/npc', new ScriptedProvider())`.
import type { DialogueProvider, DialogueReply, DialogueRequest } from './provider';

export class LLMProvider implements DialogueProvider {
  readonly id = 'llm';
  constructor(private endpoint: string, private fallback: DialogueProvider, private timeoutMs = 6000) {}

  async reply(req: DialogueRequest): Promise<DialogueReply> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`proxy ${res.status}`);
      const data = (await res.json()) as DialogueReply;
      if (typeof data.text !== 'string') throw new Error('bad reply');
      return data;
    } catch {
      return this.fallback.reply(req);
    } finally {
      clearTimeout(timer);
    }
  }
}
