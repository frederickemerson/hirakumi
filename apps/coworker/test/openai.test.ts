import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { LlmOutputError, LlmRefusalError } from "../src/llm/claude.js";
import { createOpenAiStructuredCall, OPENAI_MODEL } from "../src/llm/openai.js";

const schema = z.object({ answer: z.string() });
const fake = (response: unknown) => {
  const parse = vi.fn().mockResolvedValue(response);
  return { client: { responses: { parse } }, parse };
};

describe("OpenAI structured call (same StructuredCall contract as the Claude one)", () => {
  it("makes one tool-less structured call with the system prompt as instructions", async () => {
    const { client, parse } = fake({ status: "completed", output_parsed: { answer: "ok" }, output: [] });
    const call = createOpenAiStructuredCall(client as never);
    await expect(call({ system: "sys", user: "u", schema, maxTokens: 100 })).resolves.toEqual({ answer: "ok" });
    const params = parse.mock.calls[0][0];
    expect(OPENAI_MODEL).toBe("gpt-5.5");
    expect(params).toMatchObject({ model: "gpt-5.5", instructions: "sys", input: "u", max_output_tokens: 100 });
    expect(params.text.format.type).toBe("json_schema");
    expect(params).not.toHaveProperty("tools");
  });
  it("maps a refusal to LlmRefusalError", async () => {
    const { client } = fake({ status: "completed", output_parsed: null, output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] });
    await expect(createOpenAiStructuredCall(client as never)({ system: "s", user: "u", schema, maxTokens: 10 })).rejects.toBeInstanceOf(LlmRefusalError);
  });
  it("maps a cut-off or unparseable answer to LlmOutputError", async () => {
    const cut = fake({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_parsed: null, output: [] });
    await expect(createOpenAiStructuredCall(cut.client as never)({ system: "s", user: "u", schema, maxTokens: 10 })).rejects.toBeInstanceOf(LlmOutputError);
    const none = fake({ status: "completed", output_parsed: null, output: [] });
    await expect(createOpenAiStructuredCall(none.client as never)({ system: "s", user: "u", schema, maxTokens: 10 })).rejects.toBeInstanceOf(LlmOutputError);
  });
});
