import type { ReactNode } from "react";
import { AutoRefresh } from "./auto-refresh";

export function WaitingState({ title, detail, children }: { title: string; detail?: string; children?: ReactNode }) {
  return (
    <div role="status" className="space-y-2 rounded-lg border p-6">
      <AutoRefresh everyMs={2000} />
      <p className="font-medium">{title}</p>
      {detail && <p className="text-sm text-muted-foreground">{detail}</p>}
      {children}
    </div>
  );
}

export function ErrorState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div role="alert" className="space-y-2 rounded-lg border border-destructive/50 p-6">
      <p className="font-medium">{title}</p>
      <p className="text-sm">{detail}</p>
      {action}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg border border-dashed p-6 text-center">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{detail}</p>
      {action}
    </div>
  );
}
