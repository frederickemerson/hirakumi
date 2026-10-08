import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** The words buyers see next to a status-only promise (@hirakumi/core isStatusOnlyRule). */
export const STATUS_ONLY_LABEL = "Status-only promise";
const STATUS_ONLY_DETAIL = "It checks the status and that the answer is not an error page. It does not check what the answer says.";

/** For buyers: this text promise checks only the status and error pages, not the content. */
export function StatusOnlyNote({ className }: { className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-2 text-body text-graphite", className)} data-testid="status-only">
      <Badge variant="secondary">{STATUS_ONLY_LABEL}</Badge>
      <span>{STATUS_ONLY_DETAIL}</span>
    </p>
  );
}
