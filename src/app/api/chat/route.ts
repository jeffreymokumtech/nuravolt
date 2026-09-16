import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
} from 'ai';
import { chatModel, CHAT_MODEL_ID } from '@/lib/ai/bedrock-provider';
import {
  buildChatSystemPrompt,
  CHAT_SYSTEM_PROMPT_VERSION,
} from '@/lib/ai/chat-system-prompt';
import { getChatAccessContext } from '@/lib/ai/access-control';
import { buildChatTools } from '@/lib/ai/chat-tools';
import { wantsReportSchedule } from '@/lib/ai/tool-shapes';
import {
  ensureConversation,
  persistChatTurn,
} from '@/lib/ai/chat-persistence';
import { getChatIds } from '@/lib/ai/chat-auth';
import { recordActivity } from '@/lib/activity';
import { checkLLMBudget, llmBudgetError } from '@/lib/billing/llm-budget';
import { requireFeature } from '@/lib/billing/gate';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: Request) {
  const { userId, orgId } = await getChatIds();

  if (!userId || !orgId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Plan gate: the AI copilot is Business+ only.
  const gate = await requireFeature(orgId, 'ai:copilot');
  if (gate) return gate;

  // Org-level AI cost cap (OrgLLMBudget) — chat is the largest spender.
  const budget = await checkLLMBudget(orgId);
  if (!budget.ok) {
    return Response.json(llmBudgetError(budget), { status: 429 });
  }

  let body: {
    messages: UIMessage[];
    plantId?: string | null;
    conversationId?: string | null;
    inverterId?: string | null;
    twin?: string | null;
    range?: { from: string; to: string } | null;
    reportId?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const messages = body.messages ?? [];

  // Usage trail (founder-only /admin/usage): one row per user chat turn.
  recordActivity({
    orgClerkId: orgId,
    userId,
    action: 'chat.turn',
    targetType: 'conversation',
    targetId: body.conversationId ?? undefined,
    plantId: body.plantId ?? null,
    metadata: { messages: messages.length },
  });
  const activePlantId = body.plantId ?? null;
  const activeInverterId = body.inverterId ?? null;
  const activeTwin = body.twin ?? null;
  const activeRange = body.range ?? null;

  const activeReportId = body.reportId ?? null;

  const access = await getChatAccessContext(userId, orgId);
  const origin = new URL(request.url).origin;
  const tools = buildChatTools(access, origin, activeReportId);

  const system = buildChatSystemPrompt({
    todayIso: new Date().toISOString().slice(0, 10),
    orgName: orgId,
    plantCount: access.plants.length,
    activePlantId,
    activeInverterId,
    activeTwin,
    activeRange,
    activeReportId,
  });

  // Persistence is best-effort: if the chat tables don't exist yet (migration
  // not run), keep the chat working and log the failure.
  let conversationId: string | null = null;
  try {
    conversationId = await ensureConversation(
      body.conversationId ?? null,
      orgId,
      userId,
      activePlantId
    );
  } catch (e) {
    console.warn('[chat] ensureConversation failed (migration pending?):', e);
  }

  const startedAt = Date.now();
  const modelMessages = await convertToModelMessages(messages);

  // Qwen reliably refuses to pick proposeReportSchedule for "email me a
  // weekly report" phrasings (it reads them as "send an email now", which it
  // believes it cannot do) regardless of prompt framing. When the latest
  // user message is unambiguously a recurring-report ask, force that tool on
  // the FIRST step only; subsequent steps return to auto.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const lastUserText = (lastUser?.parts ?? [])
    .map((p: any) => (p.type === 'text' ? p.text : ''))
    .join(' ');
  const forceReportTool = wantsReportSchedule(lastUserText);

  const result = streamText({
    model: chatModel,
    system,
    messages: modelMessages,
    tools,
    // 8 steps: composition flows legitimately chain getReport -> update ->
    // getChart -> addReportChart before the closing text.
    stopWhen: stepCountIs(8),
    temperature: 0.2,
    prepareStep: forceReportTool
      ? ({ stepNumber }) =>
          stepNumber === 0
            ? { toolChoice: { type: 'tool', toolName: 'proposeReportSchedule' as const } }
            : {}
      : undefined,
  });

  return result.toUIMessageStreamResponse({
    originalMessages: messages,
    onFinish: async ({ messages: finalMessages, responseMessage }) => {
      if (!conversationId) return;
      try {
        const usage = await result.totalUsage;
        const finishReason = await result.finishReason;
        await persistChatTurn({
          conversationId,
          orgClerkId: orgId,
          userClerkId: userId,
          inputMessages: messages,
          responseMessages: responseMessage ? [responseMessage] : finalMessages,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          latencyMs: Date.now() - startedAt,
          finishReason: String(finishReason ?? 'unknown'),
          plantId: activePlantId,
          modelId: CHAT_MODEL_ID,
        });
      } catch (e) {
        console.warn('[chat] persistChatTurn failed:', e);
      }
    },
    messageMetadata: () => ({
      systemPromptVersion: CHAT_SYSTEM_PROMPT_VERSION,
    }),
  });
}
