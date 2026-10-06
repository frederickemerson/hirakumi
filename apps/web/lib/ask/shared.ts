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

export type AskRole = "user" | "assistant";
export type AskTurn = { role: AskRole; content: string };
