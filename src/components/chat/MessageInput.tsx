'use client';

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Send, Square, Slash, AtSign, MapPin, Cpu, X } from 'lucide-react';
import { useCopilotOptional } from '@/components/copilot/CopilotProvider';
import { useScopeOptions } from '@/components/chat/useScopeOptions';
import { usePlantRoutePrefix } from '@/utils/routePrefix';
import {
  matchSlashCommands,
  resolveSlashLine,
  SLASH_COMMANDS,
} from '@/lib/ai/slash-commands';

/** Trailing @-token at the caret end, e.g. "compare @riv" -> "riv". */
const AT_TOKEN_RE = /(^|\s)@([\w-]*)$/;

interface Props {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  /**
   * When `nonce` changes, the input is replaced with `text` and focused.
   * Used by the Copilot rail to pre-fill from an "Ask AI" affordance without
   * auto-sending, the user reviews, edits, and presses Send.
   */
  seed?: { text: string; nonce: number } | null;
}

export function MessageInput({ onSend, onStop, isStreaming, seed }: Props) {
  const [text, setText] = useState('');
  const [seedNonce, setSeedNonce] = useState<number | null>(null);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [tagButtonOpen, setTagButtonOpen] = useState(false);
  const [tagIndex, setTagIndex] = useState(0);
  const copilot = useCopilotOptional();
  const surface = usePlantRoutePrefix();

  const matches = useMemo(() => {
    if (!text.startsWith('/')) return [];
    const head = text.split(/\s+/)[0];
    // If the head is a complete command name AND there's whitespace after,
    // hide the palette (we're now editing args).
    if (text.includes(' ') && SLASH_COMMANDS.some((c) => c.name === head)) return [];
    return matchSlashCommands(text);
  }, [text]);

  const showPalette = matches.length > 0;

  useEffect(() => {
    setPaletteIndex(0);
  }, [matches.length]);

  // ── Scope tags (@-mention + "+ tag" button). Needs the copilot provider
  // (scope lives there) and never renders on the public showcase.
  const tagsEnabled = !!copilot && surface !== '/showcase';
  const atMatch = tagsEnabled && !showPalette ? AT_TOKEN_RE.exec(text) : null;
  const tagQuery = tagButtonOpen ? '' : atMatch?.[2] ?? null;
  const tagPaletteOpen = tagsEnabled && (tagButtonOpen || tagQuery != null);

  const scopePlantId = copilot?.resolvedScope.plantId ?? null;
  const { plants, inverters } = useScopeOptions(tagPaletteOpen, scopePlantId);

  const tagOptions = useMemo(() => {
    if (!tagPaletteOpen) return [];
    const q = (tagQuery ?? '').toLowerCase();
    const plantOpts = plants
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q))
      .map((p) => ({ kind: 'plant' as const, key: `p-${p.slug}`, id: p.slug, label: p.name, sub: p.slug }));
    const invOpts = inverters
      .filter((inv) => !q || inv.id.toLowerCase().includes(q))
      .slice(0, 6)
      .map((inv) => ({
        kind: 'inverter' as const,
        key: `i-${inv.id}`,
        id: inv.id,
        label: inv.id,
        sub: inv.group || 'inverter',
      }));
    return [...plantOpts.slice(0, 8), ...invOpts];
  }, [tagPaletteOpen, tagQuery, plants, inverters]);

  useEffect(() => {
    setTagIndex(0);
  }, [tagOptions.length, tagQuery]);

  const applyTag = (opt: { kind: 'plant' | 'inverter'; id: string; label: string }) => {
    if (!copilot) return;
    const base = copilot.manualScope ?? copilot.pageContext;
    if (opt.kind === 'plant') {
      copilot.setManualScope({ ...base, plantId: opt.id, plantName: opt.label, inverterId: undefined });
    } else {
      copilot.setManualScope({ ...base, inverterId: opt.id });
    }
    // Strip the @token the user was typing (keep the rest of the message).
    if (atMatch) setText(text.replace(AT_TOKEN_RE, '$1').trimEnd() + (text.match(AT_TOKEN_RE)?.[1] ? ' ' : ''));
    setTagButtonOpen(false);
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]')?.focus();
    });
  };

  const clearPlantTag = () => {
    if (!copilot) return;
    copilot.setManualScope(null);
    copilot.setFollowPage(true);
  };

  const clearInverterTag = () => {
    if (!copilot) return;
    const base = copilot.manualScope ?? copilot.pageContext;
    copilot.setManualScope({ ...base, inverterId: undefined });
  };

  useEffect(() => {
    if (!seed) return;
    if (seedNonce === seed.nonce) return;
    setSeedNonce(seed.nonce);
    setText(seed.text);
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(
        'textarea[data-chat-input="true"]'
      );
      ta?.focus();
      ta?.setSelectionRange(seed.text.length, seed.text.length);
    });
  }, [seed, seedNonce]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;

    // Slash command? Resolve before sending.
    const resolved = resolveSlashLine(trimmed);
    if (resolved) {
      if (resolved.result.kind === 'scope') {
        if (copilot) {
          if (resolved.result.patch === null) {
            copilot.setManualScope(null);
            copilot.setFollowPage(true);
          } else {
            const base = copilot.manualScope ?? copilot.pageContext;
            copilot.setManualScope({ ...base, ...resolved.result.patch });
          }
        }
        setText('');
        return;
      }
      onSend(resolved.result.text);
      setText('');
      return;
    }

    onSend(trimmed);
    setText('');
  };

  const applyCommand = (name: string) => {
    setText(name + ' ');
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>(
        'textarea[data-chat-input="true"]'
      );
      ta?.focus();
      const v = ta?.value ?? '';
      ta?.setSelectionRange(v.length, v.length);
    });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (tagPaletteOpen && tagOptions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setTagIndex((i) => (i + 1) % tagOptions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setTagIndex((i) => (i - 1 + tagOptions.length) % tagOptions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        applyTag(tagOptions[tagIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setTagButtonOpen(false);
        if (atMatch) setText(text.replace(AT_TOKEN_RE, '$1'));
        return;
      }
    }
    if (showPalette) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPaletteIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPaletteIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        applyCommand(matches[paletteIndex].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const pinnedPlant = copilot && !copilot.followPage && copilot.manualScope?.plantId
    ? { id: copilot.manualScope.plantId, name: copilot.manualScope.plantName ?? copilot.manualScope.plantId }
    : null;
  const pinnedInverter = copilot && !copilot.followPage ? copilot.manualScope?.inverterId ?? null : null;

  return (
    <div className="border-t border-gray-100 bg-white p-4">
      <div className="relative mx-auto max-w-3xl">
        {tagsEnabled && (pinnedPlant || pinnedInverter) && (
          <div className="mb-1.5 flex flex-wrap items-center gap-1">
            <span className="text-[9px] font-bold uppercase tracking-tight text-amber-600">Tagged</span>
            {pinnedPlant && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-amber-200">
                <MapPin className="h-2.5 w-2.5" />
                {pinnedPlant.name}
                <button
                  type="button"
                  onClick={clearPlantTag}
                  className="ml-0.5 text-amber-500 hover:text-amber-800"
                  aria-label="Remove plant tag"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            )}
            {pinnedInverter && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 ring-1 ring-amber-200">
                <Cpu className="h-2.5 w-2.5" />
                {pinnedInverter}
                <button
                  type="button"
                  onClick={clearInverterTag}
                  className="ml-0.5 text-amber-500 hover:text-amber-800"
                  aria-label="Remove inverter tag"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            )}
          </div>
        )}

        {tagPaletteOpen && tagOptions.length > 0 && (
          <ul
            role="listbox"
            aria-label="Tag a plant or inverter"
            className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-auto rounded-xl border border-gray-200 bg-white shadow-lg"
          >
            {tagOptions.map((opt, i) => (
              <li
                key={opt.key}
                role="option"
                aria-selected={i === tagIndex}
                onMouseEnter={() => setTagIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyTag(opt);
                }}
                className={[
                  'flex cursor-pointer items-center gap-2 px-3 py-2 text-xs',
                  i === tagIndex ? 'bg-amber-50' : 'hover:bg-gray-50',
                ].join(' ')}
              >
                {opt.kind === 'plant' ? (
                  <MapPin className="h-3 w-3 shrink-0 text-amber-500" />
                ) : (
                  <Cpu className="h-3 w-3 shrink-0 text-amber-500" />
                )}
                <span className="font-medium text-gray-900">{opt.label}</span>
                <span className="ml-auto text-[10px] text-gray-400">{opt.sub}</span>
              </li>
            ))}
            <li className="border-t border-gray-100 px-3 py-1.5 text-[9px] text-gray-400">
              Tags pin the conversation scope · ↑↓ · Tab/Enter to tag · Esc
            </li>
          </ul>
        )}

        {showPalette && (
          <ul
            role="listbox"
            aria-label="Slash commands"
            className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-auto rounded-xl border border-gray-200 bg-white shadow-lg"
          >
            {matches.map((cmd, i) => (
              <li
                key={cmd.name}
                role="option"
                aria-selected={i === paletteIndex}
                onMouseEnter={() => setPaletteIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyCommand(cmd.name);
                }}
                className={[
                  'flex cursor-pointer items-start gap-2 px-3 py-2 text-xs',
                  i === paletteIndex ? 'bg-blue-50' : 'hover:bg-gray-50',
                ].join(' ')}
              >
                <Slash className="mt-0.5 h-3 w-3 shrink-0 text-blue-500" />
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-[11px] font-semibold text-gray-900">
                    {cmd.signature}
                  </div>
                  <div className="text-[10px] text-gray-500">{cmd.description}</div>
                </div>
              </li>
            ))}
            <li className="border-t border-gray-100 px-3 py-1.5 text-[9px] text-gray-400">
              ↑↓ to navigate · Tab/Enter to complete · Esc to clear
            </li>
          </ul>
        )}

        <div className="flex items-end gap-2 bg-gray-50 rounded-2xl border border-gray-200 p-2 focus-within:border-blue-400 focus-within:ring-4 focus-within:ring-blue-100/50 transition-all">
          {tagsEnabled && (
            <button
              type="button"
              onClick={() => setTagButtonOpen((v) => !v)}
              className={`flex h-10 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${tagButtonOpen ? 'bg-amber-100 text-amber-700' : 'text-gray-400 hover:bg-gray-100 hover:text-amber-600'}`}
              title="Tag a plant or inverter (@)"
              aria-label="Tag a plant or inverter"
            >
              <AtSign className="h-4 w-4" />
            </button>
          )}
          <textarea
            data-chat-input="true"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={tagsEnabled ? 'Ask a question…  @ to tag, / for commands' : 'Ask a question…  Try / for commands'}
            rows={1}
            className="flex-1 resize-none bg-transparent px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none min-h-[40px] max-h-32"
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = `${target.scrollHeight}px`;
            }}
          />
          {isStreaming ? (
            <button
              onClick={onStop}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-gray-900 text-white hover:bg-gray-800 transition-colors shrink-0"
              title="Stop generation"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!text.trim()}
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 transition-all shrink-0 active:scale-90"
              title="Send message (⌘+Enter)"
            >
              <Send className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
      <p className="mt-2 text-center text-[10px] text-gray-400">
        AI can make mistakes. Verify critical information.
      </p>
    </div>
  );
}
