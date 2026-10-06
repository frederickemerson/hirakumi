import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { LlmOutputError, LlmRefusalError, type StructuredCall, type StructuredRequest } from "./claude.js";

/** The newest general GPT model on the team's key (checked with GET /v1/models on 6 Oct 2026). */
export const OPENAI_MODEL = "gpt-5.5";

type Refusal = { type: string; refusal?: string };

/** The same contract as the Claude call: one tool-less request, answer constrained to and parsed with a zod schema. */
export function createOpenAiStructuredCall(client: Pick<OpenAI, "responses">): StructuredCall {
  return async <S extends z.ZodType>({ system, user, schema, maxTokens }: StructuredRequest<S>): Promise<z.infer<S>> => {
    const res = await client.responses.parse({
      model: OPENAI_MODEL,
      instructions: system,
      input: user,
      max_output_tokens: maxTokens,
      reasoning: { effort: "low" },
      text: { format: zodTextFormat(schema as never, "answer") },
    });
    const refused = res.output.some(
      (item) => item.type === "message" && (item.content as Refusal[]).some((c) => c.type === "refusal"),
    );
    if (refused) throw new LlmRefusalError("The model declined to answer.");
    if (res.status === "incomplete") throw new LlmOutputError("The model's answer was cut off.");
    if (res.output_parsed == null) throw new LlmOutputError("The model's answer did not match the expected format.");
    return res.output_parsed as z.infer<S>;
  };
}
