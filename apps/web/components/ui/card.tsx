import * as React from "react"
import { cn } from "cn"

/*
 * White card on cream: 2px ink border, 2px corners. `interactive` adds the hard shadow and the
 * press-into-shadow hover. Set an rb-* utility in className to tint the border with the rainbow palette.
 */
function Card({
  className,
  interactive = false,
  tone = "frost",
  ...props
}: React.ComponentProps<"div"> & { interactive?: boolean; tone?: "frost" | "canary" | "ice" | "blush" | "notebook" | "ink" }) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-[2px] border-2 border-ink p-6 text-ink sm:p-8",
        tone === "frost" && "bg-frost",
        tone === "canary" && "bg-canary",
        tone === "ice" && "bg-ice",
        tone === "blush" && "bg-blush",
        tone === "notebook" && "bg-notebook",
        tone === "ink" && "bg-ink text-cream",
        interactive && "shadow-hard press",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("mb-4 flex flex-col gap-2", className)} {...props} />
}

function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 data-slot="card-title" className={cn("text-sub font-semibold uppercase tracking-[0.02em]", className)} {...props} />
}

function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-body text-graphite", className)} {...props} />
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("text-body", className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-footer" className={cn("mt-6 flex items-center gap-3", className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
