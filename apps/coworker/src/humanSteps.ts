/** The seven onboarding steps, named exactly as the web app shows them to the seller. */
export const HUMAN_STEPS = [
  "Read your file",
  "Describe endpoints",
  "Choose endpoints",
  "Prove ownership",
  "Test calls",
  "Write the promise",
  "Register on Masumi",
] as const;
export type HumanStep = (typeof HUMAN_STEPS)[number];

/** "Step 3 of 7, Choose endpoints: " — a Sokosumi task has no stepper, so its comments carry the step. */
export function stepPrefix(step: HumanStep): string {
  return `Step ${HUMAN_STEPS.indexOf(step) + 1} of ${HUMAN_STEPS.length}, ${step}: `;
}
