'use client';

import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Library, X, ExternalLink, History, Sparkles, FileText } from 'lucide-react';
import { useReportComposerOptional } from '@/components/copilot/ReportComposerContext';
import type { UIMessage } from 'ai';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { RailHistory } from '@/components/copilot/RailHistory';
import {
  useCopilot,
  COPILOT_MIN_WIDTH,
  COPILOT_MAX_WIDTH,
} from '@/components/copilot/CopilotProvider';
import { AssetContextChip } from '@/components/copilot/AssetContextChip';
import { BriefingStrip } from '@/components/copilot/BriefingStrip';
import { KnowledgeBaseDrawer } from '@/components/chat/KnowledgeBaseDrawer';
import { ExampleSessions } from '@/components/chat/demo/ExampleSessions';
import { ScriptedThreadView } from '@/components/chat/demo/ScriptedThreadView';
import { SuggestedQuestions } from '@/components/copilot/SuggestedQuestions';
import type { DemoThread } from '@/fixtures/demo-conversations/types';
import { usePlantRoutePrefix } from '@/utils/routePrefix';

const LS_CONVERSATION_ID = 'copilot_rail_conversation_id';

/**
 * Persistent right-rail Copilot. Fixed column on lg+, slide-over Sheet on
 * smaller viewports. Uses one stable conversationId per browser (kept in
 * localStorage) so reloads keep the same thread.
 */
export function CopilotRail() {
  const {
    open,
    setOpen,
    width,
    setWidth,
    pageContext,
    resolvedScope,
    seed,
    consumeSeed,
  } = useCopilot();

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [seedToInput, setSeedToInput] = useState<{ text: string; nonce: number } | null>(null);
  const [kbOpen, setKbOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [examplesOpen, setExamplesOpen] = useState(false);
  // Hydrated messages for the active conversation. null = still loading —
  // ChatPanel only mounts once hydration settles (useChat reads
  // initialMessages exactly once at init).
  const [initialMessages, setInitialMessages] = useState<UIMessage[] | null>(null);
  const [resizing, setResizing] = useState(false);
  const lastSeedNonce = useRef<number | null>(null);
  // Scripted example session currently playing (demo/showcase surfaces).
  const [demoThreads, setDemoThreads] = useState<DemoThread[]>([]);
  const [activeDemoThread, setActiveDemoThread] = useState<DemoThread | null>(null);
  const surfacePrefix = usePlantRoutePrefix();
  const composer = useReportComposerOptional();

  // Hydrate / generate a stable conversation id on first open.
  useEffect(() => {
    if (!open || conversationId) return;
    try {
      const existing = localStorage.getItem(LS_CONVERSATION_ID);
      if (existing) {
        setConversationId(existing);
        return;
      }
    } catch {}
    const fresh = (globalThis.crypto?.randomUUID?.() ??
      `cnv-${Date.now()}-${Math.random().toString(36).slice(2)}`) as string;
    try {
      localStorage.setItem(LS_CONVERSATION_ID, fresh);
    } catch {}
    setConversationId(fresh);
  }, [open, conversationId]);

  // Hydrate the active conversation's messages so reopening or switching a
  // thread shows its history (useChat itself never refetches). Fresh ids
  // 404 (nothing persisted yet) — that resolves to an empty thread.
  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    setInitialMessages(null);
    (async () => {
      try {
        const res = await fetch(`/api/chat/conversations/${conversationId}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const rows: any[] = Array.isArray(data.messages) ? data.messages : [];
        const msgs = rows.map((r) => ({
          id: r.id,
          role: r.role === 'USER' ? 'user' : r.role === 'SYSTEM' ? 'system' : 'assistant',
          parts: (r.parts as any) ?? [{ type: 'text', text: r.content }],
        })) as UIMessage[];
        if (alive) setInitialMessages(msgs);
      } catch {
        if (alive) setInitialMessages([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [conversationId]);

  const startNewConversation = () => {
    const fresh = (globalThis.crypto?.randomUUID?.() ??
      `cnv-${Date.now()}-${Math.random().toString(36).slice(2)}`) as string;
    try {
      localStorage.setItem(LS_CONVERSATION_ID, fresh);
    } catch {}
    setConversationId(fresh);
    setHistoryOpen(false);
  };

  const openConversation = (id: string) => {
    try {
      localStorage.setItem(LS_CONVERSATION_ID, id);
    } catch {}
    setConversationId(id);
    setHistoryOpen(false);
  };

  // Forward provider seeds into the input.
  useEffect(() => {
    if (!seed) return;
    if (lastSeedNonce.current === seed.nonce) return;
    lastSeedNonce.current = seed.nonce;
    setSeedToInput({ text: seed.text, nonce: seed.nonce });
    consumeSeed();
  }, [seed, consumeSeed]);

  // Keyboard shortcut: ⌘/ctrl + . toggles the rail.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, setOpen]);

  // Reserve room for the rail on lg+ by pushing body content. Restored to
  // empty on close / small viewports / unmount. The transition makes pages
  // smoothly reflow when the rail is resized.
  useEffect(() => {
    const apply = () => {
      const isLg = window.matchMedia('(min-width: 1024px)').matches;
      document.body.style.paddingRight = open && isLg ? `${width}px` : '';
      // Skip the page-flow transition while the user is actively dragging, // a transition fights the live mouse position and feels laggy.
      document.body.style.transition = resizing
        ? 'none'
        : 'padding-right 200ms ease-out';
    };
    apply();
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
      document.body.style.paddingRight = '';
      document.body.style.transition = '';
    };
  }, [open, width, resizing]);

  // Drag-to-resize: while `resizing` is true, listen for mousemove on the
  // document and recompute width from the cursor's distance to the right edge.
  useEffect(() => {
    if (!resizing) return;
    const onMove = (e: MouseEvent) => {
      const w = window.innerWidth - e.clientX;
      if (w < COPILOT_MIN_WIDTH || w > COPILOT_MAX_WIDTH) {
        setWidth(Math.min(COPILOT_MAX_WIDTH, Math.max(COPILOT_MIN_WIDTH, w)));
      } else {
        setWidth(w);
      }
    };
    const onUp = () => setResizing(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // Disable text selection on the page while dragging.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [resizing, setWidth]);

  // Closed state: a quiet pill pinned to the bottom-right. No pulsing rings,
  // no gradient, the green dot below carries any "I'm scoped" signal.
  if (!open) {
    return (
      <div className="fixed bottom-6 right-6 z-30">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-md shadow-blue-100/40 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors"
          title="Ask Shams (⌘.)"
        >
          <MessageSquare className="w-4 h-4 text-blue-600" />
          <span>Shams</span>
          {(resolvedScope.plantId || resolvedScope.inverterId) && (
            <span
              className="ml-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500"
              title="Scoped to current asset"
            />
          )}
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Mobile/tablet overlay backdrop */}
      <div
        className="fixed inset-0 z-30 bg-black/20 lg:hidden backdrop-blur-sm"
        onClick={() => setOpen(false)}
        aria-hidden
      />

      <aside
        className="ops-light-scope fixed right-0 top-0 z-40 flex h-screen flex-col border-l border-gray-200 bg-white text-gray-900 shadow-2xl lg:shadow-none"
        style={{
          width: `${width}px`,
          maxWidth: '95vw',
          transition: resizing ? 'none' : 'width 200ms ease-out',
        }}
      >
        {/* Drag handle on the left edge, only useful on lg+ where the rail
            shares horizontal space with content. Hidden on mobile (overlay). */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Shams rail"
          onMouseDown={(e) => {
            e.preventDefault();
            setResizing(true);
          }}
          onDoubleClick={() => setWidth(380)}
          className={[
            'absolute left-0 top-0 hidden lg:block h-full w-1.5 -translate-x-1/2 cursor-col-resize z-10',
            'before:absolute before:inset-y-0 before:left-1/2 before:-translate-x-1/2 before:w-px before:bg-gray-200',
            'hover:before:bg-blue-400 hover:before:w-0.5 transition-colors',
            resizing ? 'before:bg-blue-500 before:w-0.5' : '',
          ].join(' ')}
          title="Drag to resize · double-click to reset"
        />

        <header className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-blue-50 rounded-lg">
              <MessageSquare className="w-4 h-4 text-blue-600" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-gray-900">Shams</h2>
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="text-[10px] text-gray-500 font-medium">Solar operations agent</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                setExamplesOpen((v) => !v);
                setHistoryOpen(false);
                setActiveDemoThread(null);
              }}
              className={`p-2 rounded-lg transition-colors ${examplesOpen ? 'bg-amber-50 text-amber-600' : 'text-gray-400 hover:bg-gray-50 hover:text-amber-600'}`}
              title="Example sessions, see Shams in action"
              aria-label="Example sessions"
            >
              <Sparkles className="w-4 h-4" />
            </button>
            {surfacePrefix !== '/showcase' && (
              <button
                onClick={() => setHistoryOpen((h) => !h)}
                className={`p-2 rounded-lg transition-colors ${historyOpen ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:bg-gray-50 hover:text-blue-600'}`}
                title="Conversation history"
                aria-label="Conversation history"
              >
                <History className="w-4 h-4" />
              </button>
            )}
            {composer && surfacePrefix !== '/showcase' && (
              <button
                onClick={() => composer.setDrawerOpen(!composer.drawerOpen)}
                className={`p-2 rounded-lg transition-colors ${composer.drawerOpen ? 'bg-blue-50 text-blue-600' : 'text-gray-400 hover:bg-gray-50 hover:text-blue-600'}`}
                title="Report composer"
                aria-label="Report composer"
              >
                <FileText className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => setKbOpen(true)}
              className="p-2 text-gray-400 hover:bg-gray-50 hover:text-blue-600 rounded-lg transition-colors"
              title="Knowledge base, upload manuals & docs"
              aria-label="Open knowledge base"
            >
              <Library className="w-4 h-4" />
            </button>
            <a
              href={resolvedScope.plantId ? `/chat?plant=${resolvedScope.plantId}` : '/chat'}
              className="p-2 text-gray-400 hover:bg-gray-50 hover:text-blue-600 rounded-lg transition-colors"
              title="Open full Shams view"
            >
              <ExternalLink className="w-4 h-4" />
            </a>
            <div className="w-px h-4 bg-gray-200 mx-1" />
            <button
              onClick={() => setOpen(false)}
              className="p-2 text-gray-400 hover:bg-gray-50 hover:text-red-500 rounded-lg transition-colors"
              title="Close (⌘.)"
              aria-label="Close Shams"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div className="border-b border-gray-200 bg-gray-50/50">
          <AssetContextChip />
        </div>

        <BriefingStrip />

        {examplesOpen && !activeDemoThread ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
            <p className="mb-2 text-center text-[11px] text-gray-500">
              Guided example sessions on demo data. They replay instantly, nothing is sent to
              the model.
            </p>
            <ExampleSessions
              plantSlug={resolvedScope.plantId}
              onOpen={(threads, thread) => {
                setDemoThreads(threads);
                setActiveDemoThread(thread);
                setExamplesOpen(false);
              }}
            />
          </div>
        ) : historyOpen && !activeDemoThread ? (
          <RailHistory
            activeId={conversationId}
            onSelect={openConversation}
            onNew={startNewConversation}
            onClose={() => setHistoryOpen(false)}
          />
        ) : activeDemoThread ? (
          <ScriptedThreadView
            thread={activeDemoThread}
            siblings={demoThreads.filter((t) => t.id !== activeDemoThread.id)}
            onBack={() => setActiveDemoThread(null)}
            onOpenThread={(t) => setActiveDemoThread(t)}
          />
        ) : initialMessages == null && conversationId ? (
          <div className="flex flex-1 items-center justify-center text-xs text-gray-400">
            Loading conversation…
          </div>
        ) : (
          <ChatPanel
            key={conversationId ?? 'fresh'}
            initialMessages={initialMessages ?? undefined}
            conversationId={conversationId ?? undefined}
            pageContext={resolvedScope}
            seed={seedToInput}
            emptyState={
              <>
                <ExampleSessions
                  plantSlug={resolvedScope.plantId}
                  onOpen={(threads, thread) => {
                    setDemoThreads(threads);
                    setActiveDemoThread(thread);
                  }}
                />
                {/* Free-form chips are suppressed on /showcase: live sends
                    401 for anonymous visitors, example sessions lead there. */}
                {surfacePrefix !== '/showcase' && <SuggestedQuestions />}
              </>
            }
          />
        )}
      </aside>

      <KnowledgeBaseDrawer open={kbOpen} onClose={() => setKbOpen(false)} />
    </>
  );
}
