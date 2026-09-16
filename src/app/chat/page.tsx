import { ChatHeader } from '@/components/chat/ChatHeader';
import UpgradeGate from '@/components/billing/UpgradeGate';
import { NewChatPanel } from './_components/NewChatPanel';

export default function ChatPage({
  searchParams,
}: {
  searchParams?: { plant?: string };
}) {
  // Plant scope handed over from the dashboard (nav rail / switcher / rail
  // link). Access control happens server-side in /api/chat per tool call —
  // this only seeds the request context.
  const plantId = searchParams?.plant ?? null;

  return (
    <UpgradeGate
      feature="ai:copilot"
      fullPage
      title="Shams is included with Business"
      blurb="Upgrade to Business to put Shams, your AI agent, to work on your fleet's live data."
    >
      <main className="flex min-w-0 flex-1 flex-col">
        <ChatHeader plantName={plantId} />
        <NewChatPanel plantId={plantId} />
      </main>
    </UpgradeGate>
  );
}
