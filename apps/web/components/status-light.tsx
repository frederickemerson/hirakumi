import { statusLight, type ApiStatusTone, type StatusLightColor } from "@/lib/status-labels";
import type { ApiState } from "@/lib/types";
import { cn } from "@/lib/utils";

const LIGHT_COLOR: Record<StatusLightColor, string> = {
  mint: "bg-mint",
  coral: "bg-coral",
  pencil: "bg-pencil",
  sky: "bg-sky",
};

/**
 * A round light before an API's name in the seller's lists (/apis and /account). Hover or keyboard focus shows its
 * label beside it; screen readers read it as an image with that label. Live and healthy pulses unless motion is reduced.
 */
export function StatusLight({ tone, state }: { tone: ApiStatusTone; state: ApiState }) {
  const { color, label, pulse } = statusLight(tone, state);
  return (
    <span
      role="img"
      aria-label={label}
      tabIndex={0}
      className="group relative inline-flex size-4 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
    >
      <span aria-hidden className={cn("size-2.5 rounded-full border border-ink", LIGHT_COLOR[color], pulse && "animate-status-pulse")} />
      <span
        aria-hidden
        className="pointer-events-none invisible absolute top-1/2 left-full z-10 ml-2 w-max max-w-[16rem] -translate-y-1/2 rounded-[2px] border border-ink bg-ink px-2 py-1 text-caption text-frost opacity-0 transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100 motion-reduce:transition-none"
      >
        {label}
      </span>
    </span>
  );
}
