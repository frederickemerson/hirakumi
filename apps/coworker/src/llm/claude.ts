import type Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

// The claude-api skill default (no other model was named); one small structured call per onboarding.
export const LLM_MODEL = "claude-opus-5-5";

export type StructuredRequest<S extends z.ZodType> = { system: string; user: string; schema: S; maxTokens: number };
/** One tool-less Claude call whose answer is constrained to, and parsed with, a zod schema. */
export type StructuredCall = <S extends z.ZodType>(req: StructuredRequest<S>) => Promise<z.infer<S>>;

/** The model declined (stop_reason "refusal"). */
export class LlmRefusalError extends Error {}
/** The answer was truncated or did not fit the schema/our checks. */
export class LlmOutputError extends Error {}

export function createStructuredCall(client: Pick<Anthropic, "messages">): StructuredCall {
  return async <S extends z.ZodType>({ system, user, schema, maxTokens }: StructuredRequest<S>): Promise<z.infer<S>> => {
    const res = await client.messages.parse({
      model: LLM_MODEL,
      max_tokens: maxTokens,
      output_config: { format: zodOutputFormat(schema), effort: "low" },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (res.stop_reason === "refusal") throw new LlmRefusalError("The model declined to answer.");
    if (res.stop_reason === "max_tokens") throw new LlmOutputError("The model's answer was cut off.");
    if (res.parsed_output == null) throw new LlmOutputError("The model's answer did not match the expected format.");
    return res.parsed_output as z.infer<S>;
  };
}

/** Untrusted text goes inside XML-ish tags as JSON; escaping '<' stops it from closing the tag. */
export function quoteAsData(tag: string, data: unknown): string {
  return `<${tag}>\n${JSON.stringify(data).replace(/</g, "\\u003c")}\n</${tag}>`;
}
