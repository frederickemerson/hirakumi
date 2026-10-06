import { Badge } from "@/components/ui/badge";
import { healthLabel, STATE_LABEL } from "@/lib/copy";
import { isStale } from "@/lib/flow";
import type { ApiState, Health } from "@/lib/types";

export function HealthBadge({ state, health, checkedAt, now }: {
  state: ApiState;
  health: Health;
  checkedAt: Date | string | null;
  now?: Date;
}) {
  if (state !== "live") return <Badge variant="secondary">{STATE_LABEL[state]}</Badge>;
  const checked = checkedAt ? new Date(checkedAt) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Badge variant={health === "healthy" ? "default" : "destructive"}>{healthLabel(health)}</Badge>
      {isStale(checked, now) && (
        <span role="note" className="text-xs text-amber-700">
          {checked
            ? "The last health check was more than 10 minutes ago. The monitor may have stopped."
            : "Not checked yet."}
        </span>
      )}
    </span>
  );
}
