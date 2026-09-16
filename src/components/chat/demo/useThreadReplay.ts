'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import type { DemoThread } from '@/fixtures/demo-conversations/types';

/**
 * Deterministic typewriter replay over a scripted DemoThread:
 *   - user messages appear whole after a short beat
 *   - tool parts mount as 'input-available' (ToolCallCard pulses "Running")
 *     for a moment, then flip to 'output-available' (rich card mounts)
 *   - text parts stream a few words per tick
 * skip() or prefers-reduced-motion jumps straight to the complete thread.
 * All timers are cleaned on unmount / thread change.
 */

const USER_BEAT_MS = 350;
const TOOL_RUN_MS = 700;
const TEXT_TICK_MS = 60;
const WORDS_PER_TICK = 2;

interface Cursor {
  msg: number;
  part: number;
  /** For text parts: number of words revealed so far. */
  word: number;
  /** For tool parts: has the output flipped visible yet. */
  toolDone: boolean;
}

function partWordCount(part: any): number {
  return part.type === 'text' ? String(part.text ?? '').split(/\s+/).length : 0;
}

export function useThreadReplay(thread: DemoThread) {
  const [cursor, setCursor] = useState<Cursor>({ msg: 0, part: -1, word: 0, toolDone: false });
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  // Reset when the thread changes.
  useEffect(() => {
    setCursor({ msg: 0, part: -1, word: 0, toolDone: false });
    setDone(Boolean(reducedMotion));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.id]);

  useEffect(() => {
    if (done) return;
    const messages = thread.messages;
    const msg = messages[cursor.msg];
    if (!msg) {
      setDone(true);
      return;
    }

    const advance = (next: Cursor, delay: number) => {
      timer.current = setTimeout(() => setCursor(next), delay);
    };

    // Entering a message: reveal its first part after a beat.
    if (cursor.part === -1) {
      advance({ ...cursor, part: 0, word: 0, toolDone: false }, USER_BEAT_MS);
      return;
    }

    const part: any = msg.parts[cursor.part];
    if (!part) {
      // Message finished → next message.
      advance({ msg: cursor.msg + 1, part: -1, word: 0, toolDone: false }, USER_BEAT_MS);
      return;
    }

    if (msg.role === 'user') {
      // User messages appear whole; jump past all parts.
      advance({ msg: cursor.msg + 1, part: -1, word: 0, toolDone: false }, USER_BEAT_MS);
      return;
    }

    if (part.type === 'text') {
      const total = partWordCount(part);
      if (cursor.word < total) {
        advance({ ...cursor, word: cursor.word + WORDS_PER_TICK }, TEXT_TICK_MS);
      } else {
        advance({ ...cursor, part: cursor.part + 1, word: 0, toolDone: false }, TEXT_TICK_MS);
      }
      return;
    }

    // Tool part: show as running briefly, then flip the output visible.
    if (!cursor.toolDone) {
      advance({ ...cursor, toolDone: true }, TOOL_RUN_MS);
    } else {
      advance({ ...cursor, part: cursor.part + 1, word: 0, toolDone: false }, USER_BEAT_MS);
    }
  }, [cursor, done, thread]);

  const visibleMessages: UIMessage[] = useMemo(() => {
    if (done) return thread.messages;
    const out: UIMessage[] = [];
    for (let m = 0; m < thread.messages.length && m <= cursor.msg; m++) {
      const msg = thread.messages[m];
      if (m < cursor.msg) {
        out.push(msg);
        continue;
      }
      if (cursor.part === -1) {
        // Message not yet revealed.
        if (msg.role === 'user') out.push(msg);
        continue;
      }
      const parts: any[] = [];
      for (let p = 0; p < msg.parts.length && p <= cursor.part; p++) {
        const part: any = msg.parts[p];
        if (p < cursor.part) {
          parts.push(part);
          continue;
        }
        if (part.type === 'text') {
          const words = String(part.text ?? '').split(/\s+/);
          parts.push({ ...part, text: words.slice(0, cursor.word).join(' ') });
        } else if (part.type?.startsWith('tool-')) {
          parts.push(cursor.toolDone ? part : { ...part, state: 'input-available', output: undefined });
        } else {
          parts.push(part);
        }
      }
      if (parts.length) out.push({ ...msg, parts } as UIMessage);
    }
    return out;
  }, [thread, cursor, done]);

  const skip = () => {
    if (timer.current) clearTimeout(timer.current);
    setDone(true);
  };

  const replay = () => {
    if (timer.current) clearTimeout(timer.current);
    setCursor({ msg: 0, part: -1, word: 0, toolDone: false });
    setDone(false);
  };

  return { visibleMessages, done, skip, replay };
}
