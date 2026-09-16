import { notFound } from 'next/navigation';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { ChatHeader } from '@/components/chat/ChatHeader';
import UpgradeGate from '@/components/billing/UpgradeGate';
import prisma from '@/libs/prisma';
import type { UIMessage } from 'ai';

import { getChatIds } from '@/lib/ai/chat-auth';

async function getCurrentUserId(): Promise<string | null> {
  const { userId } = await getChatIds();
  return userId;
}

interface Props {
  params: { conversationId: string };
}

export default async function ConversationPage({ params }: Props) {
  const userId = await getCurrentUserId();
  if (!userId) notFound();

  let conversation: { id: string; title: string; plant_id: string | null } | null =
    null;
  let initialMessages: UIMessage[] = [];

  try {
    const found = await prisma.conversation.findUnique({
      where: { id: params.conversationId },
    });
    if (!found || found.user_clerk_id !== userId) notFound();

    const rows = await prisma.chatMessage.findMany({
      where: { conversation_id: found.id },
      orderBy: { created_at: 'asc' },
    });

    conversation = {
      id: found.id,
      title: found.title,
      plant_id: found.plant_id,
    };

    initialMessages = rows.map((r) => ({
      id: r.id,
      role: roleToUi(r.role),
      parts: (r.parts as any) ?? [{ type: 'text', text: r.content }],
    })) as UIMessage[];
  } catch (e) {
    // Migration not run yet, fall through to empty conversation
    console.warn('[chat] conversation hydrate failed:', e);
    conversation = {
      id: params.conversationId,
      title: 'Conversation',
      plant_id: null,
    };
  }

  return (
    <UpgradeGate
      feature="ai:copilot"
      fullPage
      title="Shams is included with Business"
      blurb="Upgrade to Business to put Shams, your AI agent, to work on your fleet's live data."
    >
      <main className="flex min-w-0 flex-1 flex-col">
        <ChatHeader title={conversation?.title} plantName={conversation?.plant_id ?? null} />
        <ChatPanel
          conversationId={conversation?.id ?? params.conversationId}
          plantId={conversation?.plant_id ?? null}
          initialMessages={initialMessages}
        />
      </main>
    </UpgradeGate>
  );
}

function roleToUi(role: string): 'user' | 'assistant' | 'system' {
  if (role === 'USER') return 'user';
  if (role === 'SYSTEM') return 'system';
  return 'assistant';
}
