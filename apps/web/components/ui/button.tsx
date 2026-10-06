import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Spinner } from "@/components/ui/spinner"

/*
 * Hirakumi buttons: mono 500 text, 2px ink border, 2px corners, hard offset shadow that the
 * button presses into on hover. Sky blue is the only filled action colour.
 */
const buttonVariants = cva(
  "group/button relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[2px] border-2 border-ink font-medium whitespace-nowrap select-none outline-none disabled:pointer-events-none disabled:opacity-60 aria-busy:cursor-progress [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-sky text-ink shadow-hard press",
        outline: "bg-frost text-ink shadow-hard press",
        /** White tile with a rainbow border: pair with an rb-* utility (never next to a filled chromatic button). */
        rainbow: "bg-frost text-ink shadow-hard press rb-border",
        /** Nav CTA: sky fill, thinner border, no shadow. */
        nav: "border-[1.5px] bg-sky text-ink text-caption font-semibold uppercase tracking-[0.04em] hover:bg-ice",
        ghost: "border-transparent bg-transparent text-ink hover:bg-ice",
        destructive: "bg-coral text-ink shadow-hard press",
        link: "h-auto border-0 p-0 text-ink underline underline-offset-4 hover:text-graphite",
      },
      size: {
        default: "min-h-11 px-6 py-[10px] text-body",
        sm: "min-h-9 px-4 py-2 text-caption",
        lg: "min-h-12 px-8 py-3 text-body-lg",
        xs: "min-h-8 px-3 py-1 text-caption",
        icon: "size-11",
        "icon-sm": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Shows a spinner, marks the button busy and disables it until the work is done. */
    pending?: boolean
    /** Replaces the label while pending (keep it short: "Saving…"). */
    pendingLabel?: React.ReactNode
  }

function Button({
  className,
  variant = "default",
  size = "default",
  pending = false,
  pendingLabel,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      aria-busy={pending || undefined}
      disabled={disabled || pending}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {pending && <Spinner className="size-3.5" />}
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants }
