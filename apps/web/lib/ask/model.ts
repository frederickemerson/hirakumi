import OpenAI from "openai";
import type { AskTurn } from "./shared";

/** The same model the Sokosumi coworker uses (apps/coworker/src/llm/openai.ts). */
const ASK_MODEL = "gpt-5.5";

/**
 * About 500 visible tokens. GPT-5.5 counts its (low effort) reasoning inside this budget too, so it gets a little
 * headroom; the instructions ask for answers under 120 words.
 */
const ASK_MAX_OUTPUT_TOKENS = 600;

/** Said when the model stops early, so the reader knows the answer is incomplete. */
export const CUT_OFF_NOTE = "\n\n(That answer was cut short. Try asking a narrower question.)";

/**
 * Streams the answer text. One tool-less Responses API call: no tools, no web search, no URL fetching, and
 * nothing stored on OpenAI's side. Throws on transport or API errors before the first chunk.
 */
export async function* streamAnswer(apiKey: string, instructions: string, turns: AskTurn[], signal?: AbortSignal): AsyncGenerator<string> {
  const client = new OpenAI({ apiKey, timeout: 30_000, maxRetries: 1 });
  const stream = await client.responses.create(
    {
      model: ASK_MODEL,
      instructions,
      input: turns.map((t) => ({ role: t.role, content: t.content })),
      max_output_tokens: ASK_MAX_OUTPUT_TOKENS,
      reasoning: { effort: "low" },
      store: false,
      stream: true,
    },
    { signal },
  );
  for await (const event of stream) {
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") yield event.delta;
    else if (event.type === "response.incomplete") yield CUT_OFF_NOTE;
    else if (event.type === "response.failed" || event.type === "error") throw new Error("The model stopped with an error.");
  }
}
