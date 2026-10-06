import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/* Yellow badge from the guide: canary fill, 1px ink border, mono 600 11px uppercase, 4px 8px. */
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 rounded-[2px] border border-ink px-2 py-1 text-caption font-semibold uppercase tracking-[0.04em] whitespace-nowrap text-ink [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-canary",
        secondary: "bg-chalk",
        destructive: "bg-coral",
        outline: "bg-frost",
        sky: "bg-sky",
        mint: "bg-mint/40",
        ghost: "border-transparent bg-transparent",
        link: "border-transparent bg-transparent underline underline-offset-4",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
