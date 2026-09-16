import prisma from '@/libs/prisma';
import type { UIMessage } from 'ai';
import { enumsForModelId, estimateLLMCostUsd } from './llm-pricing';

export interface PersistTurnArgs {
  conversationId: string;
  orgClerkId: string;
  userClerkId: string;
  /** UI messages from the request (user turn the model is responding to). */
  inputMessages: UIMessage[];
  /** Final assistant UI messages emitted by streamText.onFinish. */
  responseMessages: UIMessage[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  finishReason: string;
  plantId?: string | null;
  modelId: string;
}

/**
 * Persists a chat turn:
 *   1. The new user message (most-recent USER role from inputMessages).
 *   2. Each assistant message emitted (text and tool calls live in `parts`).
 *   3. One LLMInteraction row aggregating tokens/cost for the turn.
 * Uses transactions so a single insert failure doesn't leave a half-saved turn.
 */
export async function persistChatTurn(args: PersistTurnArgs): Promise<void> {
  const {
    conversationId,
    orgClerkId,
    userClerkId,
    inputMessages,
    responseMessages,
    inputTokens,
    outputTokens,
    latencyMs,
    finishReason,
    plantId,
    modelId,
  } = args;

  const lastUser = [...inputMessages].reverse().find((m) => m.role === 'user');
  const costUsd = estimateLLMCostUsd(modelId, inputTokens, outputTokens);
  const { provider, model } = enumsForModelId(modelId);

  await prisma.$transaction(async (tx) => {
    const interaction = await tx.lLMInteraction.create({
      data: {
        org_clerk_id: orgClerkId,
        user_clerk_id: userClerkId,
        provider,
        model,
        interaction_type: 'CHAT',
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd,
        latency_ms: latencyMs,
        plant_id: plantId ?? null,
        success: true,
      },
    });

    if (lastUser) {
      await tx.chatMessage.create({
        data: {
          conversation_id: conversationId,
          role: 'USER',
          content: extractText(lastUser),
          parts: lastUser.parts as any,
        },
      });
    }

    for (const msg of responseMessages) {
      await tx.chatMessage.create({
        data: {
          conversation_id: conversationId,
          role: roleFor(msg.role),
          content: extractText(msg),
          parts: msg.parts as any,
          llm_interaction_id: interaction.id,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          finish_reason: finishReason,
        },
      });
    }

    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        updated_at: new Date(),
        ...(plantId ? { plant_id: plantId } : {}),
      },
    });
  });

  // Auto-title once: when only one assistant turn exists, use first 60 chars of
  // the user's question. Cheaper than a separate LLM call.
  if (lastUser) {
    const count = await prisma.chatMessage.count({
      where: { conversation_id: conversationId },
    });
    if (count <= 3) {
      const title = extractText(lastUser).slice(0, 60).trim();
      if (title) {
        await prisma.conversation.update({
          where: { id: conversationId },
          data: { title },
        });
      }
    }
  }
}

function extractText(msg: UIMessage): string {
  return msg.parts
    .map((p: any) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

function roleFor(role: string): 'USER' | 'ASSISTANT' | 'TOOL' | 'SYSTEM' {
  if (role === 'user') return 'USER';
  if (role === 'assistant') return 'ASSISTANT';
  if (role === 'system') return 'SYSTEM';
  return 'TOOL';
}

export async function ensureConversation(
  id: string | null,
  orgClerkId: string,
  userClerkId: string,
  plantId?: string | null
): Promise<string> {
  const base = {
    org_clerk_id: orgClerkId,
    user_clerk_id: userClerkId,
    plant_id: plantId ?? null,
  };

  // Honor the client-supplied id: clients keep ONE stable id per thread
  // (NewChatPanel uuid, the rail's localStorage id) and resend it every
  // turn. Creating with a server-minted uuid here silently split every
  // turn into its own conversation — the client id never matched a row.
  const clientId = id && id.length <= 64 ? id : null;
  if (clientId) {
    const existing = await prisma.conversation.findUnique({ where: { id: clientId } });
    if (existing) {
      if (existing.user_clerk_id === userClerkId) return existing.id;
      // Foreign id (collision or cross-account reuse): never attach to it —
      // fall through and mint a fresh id below.
    } else {
      try {
        const created = await prisma.conversation.create({
          data: { id: clientId, ...base },
        });
        return created.id;
      } catch {
        // Unique-constraint race: another request created it between our
        // read and write. Use it if it is ours.
        const raced = await prisma.conversation.findUnique({ where: { id: clientId } });
        if (raced && raced.user_clerk_id === userClerkId) return raced.id;
      }
    }
  }

  const created = await prisma.conversation.create({ data: base });
  return created.id;
}
