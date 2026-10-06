import { humanizeStep, STEP_STATUS_LABEL } from "@/lib/copy";
import type { OnboardStep } from "@/lib/types";

export function StepList({ steps }: { steps: OnboardStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm">
      {steps.map((s) => (
        <li key={s.step} className="flex justify-between gap-4">
          <span>{humanizeStep(s.step)}</span>
          <span className="text-muted-foreground">{STEP_STATUS_LABEL[s.status]}</span>
        </li>
      ))}
    </ul>
  );
}
