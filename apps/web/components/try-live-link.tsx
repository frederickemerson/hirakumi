import Link from "next/link";
import { useId } from "react";
import { buttonVariants } from "@/components/ui/button";
import type { ApiState, Health } from "@/lib/types";
import { cn } from "@/lib/utils";

export const TRY_LABEL = "Try it live";
export const TRY_DOWN_REASON = "Down right now. You can try it again once it passes its checks.";

export const tryHref = (apiId: string) => `/p/${encodeURIComponent(apiId)}/try`;
/** The seller's own Try it live in the dashboard. */
export const sellerTryHref = (apiId: string) => `/apis/${encodeURIComponent(apiId)}/try`;

/**
 * The one "Try it live" button every surface uses. Live and healthy: a link to the try page. Live and Down:
 * a disabled button with the reason beside it. Not live: nothing, since there is nothing to try yet.
 */
export function TryLiveLink({ apiId, state, health, label = TRY_LABEL, variant = "default", size = "default", className, href }: {
  apiId: string;
  /** Default the public try page; seller surfaces pass sellerTryHref. */
  href?: string;
  state: ApiState;
  health: Health;
  label?: string;
  variant?: "default" | "outline";
  size?: "default" | "sm" | "lg";
  className?: string;
}) {
  const reasonId = useId();
  if (state !== "live") return null;
  if (health === "down") {
    return (
      <span className="inline-flex flex-col items-start gap-1">
        <button type="button" disabled aria-describedby={reasonId} className={cn(buttonVariants({ variant, size }), className)}>
          {label}
        </button>
        <span id={reasonId} className="max-w-60 text-caption text-graphite">{TRY_DOWN_REASON}</span>
      </span>
    );
  }
  return <Link href={href ?? tryHref(apiId)} className={cn(buttonVariants({ variant, size }), className)}>{label}</Link>;
}
