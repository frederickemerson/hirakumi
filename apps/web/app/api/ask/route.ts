import { sellerSummary } from "@/lib/ask/context";
import { buildInstructions, offlineAnswer } from "@/lib/ask/facts";
import { streamAnswer } from "@/lib/ask/model";
import { askBucket, takeAskSlot } from "@/lib/ask/rate-limit";
import { MAX_HISTORY_MESSAGES, MAX_QUESTION_CHARS, type AskTurn } from "@/lib/ask/shared";
import { getSql } from "@/lib/db";
import { env } from "@/lib/env";
import { errorJson, readJson, sameOrigin } from "@/lib/http";
import { readCookie, readSessionToken, SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Earlier assistant answers are capped too, so a forged history can't blow up the prompt. */
const MAX_HISTORY_CHARS = 2000;

const MID_STREAM_ERROR = "\n\n(Sorry, the answer stopped. Please ask again.)";

/** The earlier conversation the panel sent: well-formed user and assistant turns only, newest last, bounded. */
function readHistory(raw: unknown): AskTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns = raw.flatMap((t): AskTurn[] => {
    const role = (t as { role?: unknown })?.role;
    const content = (t as { content?: unknown })?.content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string" || !content.trim()) return [];
    return [{ role, content: content.slice(0, MAX_HISTORY_CHARS) }];
  });
  return turns.slice(-MAX_HISTORY_MESSAGES);
}

function textStream(source: "model" | "faq", chunks: AsyncIterable<string>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-ask-source": source,
    },
  });
}

/** The offline answer, sent a few words at a time so the panel renders it the same way as a model answer. */
async function* wordsOf(text: string): AsyncGenerator<string> {
  const words = text.match(/\S+\s*/g) ?? [text];
  for (let i = 0; i < words.length; i += 4) yield words.slice(i, i + 4).join("");
}

/**
 * The model's answer. Waits for the first chunk before the response starts, so an OpenAI failure (bad key,
 * quota, outage) still gets the offline answer with a 200 instead of an error.
 */
async function modelAnswer(apiKey: string, instructions: string, turns: AskTurn[], question: string, signal: AbortSignal) {
  const answer = streamAnswer(apiKey, instructions, turns, signal);
  let first: IteratorResult<string>;
  try {
    first = await answer.next();
  } catch (e) {
    console.error("ask: OpenAI failed, answering from the offline FAQ", e instanceof Error ? e.message : e);
    return textStream("faq", wordsOf(offlineAnswer(question)));
  }
  async function* rest(): AsyncGenerator<string> {
    if (first.done) return;
    yield first.value;
    try {
      for (;;) {
        const next = await answer.next();
        if (next.done) return;
        yield next.value;
      }
    } catch (e) {
      console.error("ask: OpenAI stream broke", e instanceof Error ? e.message : e);
      yield MID_STREAM_ERROR;
    }
  }
  return textStream("model", rest());
}

/**
 * "Ask Hirakumi": a general help assistant. Sign-in is optional; a signed-in seller's own APIs are summarised
 * for the model from the session, never from the request. Questions are untrusted: no tools, no URL fetching,
 * a bounded question and answer, and a per-caller rate limit counted in Postgres.
 */
export async function POST(req: Request): Promise<Response> {
  if (!sameOrigin(req)) return errorJson(403, "Cross-site request refused.");
  const body = await readJson(req);
  if (!body) return errorJson(400, "Send your question as JSON.");
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return errorJson(400, "Write a question first.");
  if (question.length > MAX_QUESTION_CHARS) return errorJson(400, "Keep questions under 1,000 characters.");

  const token = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  const session = token ? readSessionToken(token) : null;
  const sql = getSql();

  let allowed = true;
  try {
    allowed = await takeAskSlot(sql, askBucket(session?.sellerId ?? null, req));
  } catch (e) {
    // Best effort: if the counter can't be read, answer anyway. Length and output caps still bound the cost.
    console.error("ask: rate limit unavailable", e instanceof Error ? e.message : e);
  }
  if (!allowed) return errorJson(429, "That's a lot of questions at once. Please try again in a few minutes.");

  const apiKey = env.openaiApiKey();
  if (!apiKey) return textStream("faq", wordsOf(offlineAnswer(question)));

  let seller: { apis: string | null } | null = null;
  if (session) {
    try {
      seller = { apis: await sellerSummary(sql, session.sellerId) };
    } catch (e) {
      console.error("ask: seller summary unavailable", e instanceof Error ? e.message : e);
    }
  }
  const turns: AskTurn[] = [...readHistory(body.history), { role: "user", content: question }];
  return modelAnswer(apiKey, buildInstructions(seller), turns, question, req.signal);
}
