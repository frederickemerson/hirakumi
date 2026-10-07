/* Client-safe pieces of "Ask Hirakumi", shared by the panel (components/ask-hirakumi.tsx) and /api/ask. */

/** The longest question /api/ask accepts. The panel's input stops at the same length. */
export const MAX_QUESTION_CHARS = 1000;

/** How many earlier messages the panel sends along, so follow-up questions make sense. */
export const MAX_HISTORY_MESSAGES = 6;

/** The chips shown in an empty conversation. Each has a written answer in the offline FAQ. */
export const SUGGESTED_QUESTIONS = [
  "How do I list my API?",
  "Is my money safe?",
  "Why do you need my wallet?",
  "What does an agent pay?",
] as const;

/** What the ownership step's help button asks when the DNS provider is unknown. Answered offline too. */
export const DNS_HELP_QUESTION = "How do I add the _hirakumi TXT record for my API?";

/** More questions the offline FAQ answers word for word (not shown as starting chips). */
export const EXTRA_QUESTIONS = ["What does a promise look like?", "Do I need a wallet?", DNS_HELP_QUESTION] as const;

/** The landing page FAQ, answered word for word offline too. */
export const LANDING_QUESTIONS = [
  "Do I have to change my API?",
  "Can I do it from Sokosumi?",
  "Who decides pass or fail?",
  "What happens when my API goes down?",
  "Is this on mainnet?",
  "What does it cost?",
] as const;

/** Every question with a written answer. In an answer, each one shows as a chip that asks it. */
export const OFFLINE_QUESTIONS: readonly string[] = [...SUGGESTED_QUESTIONS, ...EXTRA_QUESTIONS, ...LANDING_QUESTIONS];

/** The live demo API's try page, linked from the offline answer. */
export const TRY_DEMO_PATH = "/p/api_eejiaioyqt/try";

export type AskRole = "user" | "assistant";
export type AskTurn = { role: AskRole; content: string };
