import axios from "axios";

/**
 * @deprecated Unused as of 2026-05. The chat/insights/alert paths now use AWS
 * Bedrock + Claude Haiku 4.5 (see src/lib/ai/bedrock.ts and
 * src/lib/ai/bedrock-provider.ts). This file is retained only for any future
 * lead-gen flows that may still reference OpenRouter; safe to delete once
 * confirmed.
 */

// OpenRouter API for LLM calls
// Docs: https://openrouter.ai/docs
// Free tier: 20 req/min, 50 req/day

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Default model - Llama 3.3 70B (free tier)
const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

export const sendOpenRouter = async (
  messages: any[], // TODO: type this
  userId: number,
  max = 100,
  temp = 1,
  model = DEFAULT_MODEL
) => {
  const url = `${OPENROUTER_BASE_URL}/chat/completions`;

  console.log("Ask OpenRouter >>>");

  messages.map((m) =>
    console.log(" - " + m.role.toUpperCase() + ": " + m.content)
  );

  const body = JSON.stringify({
    model,
    messages,
    max_tokens: max,
    temperature: temp,
  });

  const options = {
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://nuravolt.com",
      "X-Title": "NuraVolt",
    },
  };

  try {
    const res = await axios.post(url, body, options);
    const answer = res.data.choices[0].message.content;
    const usage = res?.data?.usage;

    console.log(">>> " + answer);

    console.log(
      "TOKENS USED: " +
        usage?.total_tokens +
        " (prompt: " +
        usage?.prompt_tokens +
        " / response: " +
        usage?.completion_tokens +
        ")"
    );

    console.log("\n");

    return answer;
  } catch (e) {
    console.error("OpenRouter Error: " + e?.response?.status, e?.response?.data);

    return null;
  }
};

// Legacy alias for backwards compatibility
export const sendOpenAi = sendOpenRouter;
