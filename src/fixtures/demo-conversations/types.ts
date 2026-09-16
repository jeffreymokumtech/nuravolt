import type { UIMessage } from 'ai';

/**
 * Scripted Shams example sessions for the public demo surfaces. Hand-authored
 * TS modules (never fetched JSON): compile-time checked against UIMessage,
 * zero runtime fetches, and tool outputs are COMPUTED from the shipped
 * fixture JSON through the same shapers the live tools use
 * (src/lib/ai/tool-shapes.ts) — number drift is structurally impossible.
 *
 * Authoring rules: sentence case, no em/en dashes, no emoji, display names
 * only (never internal plant names). Prose numerals must come from the same
 * computed values the tool outputs carry (build strings with template
 * literals over those constants).
 */
export interface DemoThread {
  id: string;
  /** Chip label, sentence case. */
  title: string;
  /** The opening user question (also usable as a suggested chip). */
  prompt: string;
  plantSlug: string;
  plantName: string;
  surface: 'demo' | 'showcase';
  messages: UIMessage[];
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

export function userMsg(text: string): UIMessage {
  return {
    id: nextId('demo-u'),
    role: 'user',
    parts: [{ type: 'text', text }],
  } as UIMessage;
}

export function assistantMsg(parts: UIMessage['parts']): UIMessage {
  return { id: nextId('demo-a'), role: 'assistant', parts } as UIMessage;
}

export const textPart = (text: string) => ({ type: 'text' as const, text });

export function toolPart(toolName: string, input: unknown, output: unknown) {
  return {
    type: `tool-${toolName}`,
    toolCallId: nextId('demo-call'),
    state: 'output-available' as const,
    input,
    output,
  } as any;
}
