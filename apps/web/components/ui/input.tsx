import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "cn"

/** White, 2px ink border, 2px corners. Focus thickens the border to sky; there is no glow ring. */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 rounded-[2px] border-2 border-ink bg-frost px-3 py-2 text-body text-ink outline-none transition-colors duration-100 placeholder:text-pencil file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-body file:font-medium file:text-ink focus-visible:border-sky focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:border-pencil disabled:bg-chalk disabled:text-graphite aria-invalid:border-coral",
        className
      )}
      {...props}
    />
  )
}

export { Input }
