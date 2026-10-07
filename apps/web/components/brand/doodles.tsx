import { cn } from "cn"

/*
 * Hand-drawn doodles for the landing page. Loose pencil lines in charcoal (#383838) and
 * wet-cement blue (#54b4de); fills in orange and yellow. All decorative (aria-hidden).
 */
/** `data-float` marks a doodle for the Floaters drift animation, so it must reach the <svg>. */
type DoodleProps = { className?: string; style?: React.CSSProperties; "data-float"?: boolean }

const base = { fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const, focusable: "false" as const }

export function CloudDoodle({ className, style, ...rest }: DoodleProps) {
  return (
    <svg viewBox="0 0 160 70" className={cn("h-16 w-auto", className)} style={style} {...base} {...rest}>
      <path
        d="M26 60 C8 61 5 40 20 36 C15 22 34 14 46 22 C50 6 82 5 88 24 C104 16 124 28 118 42 C138 43 137 61 118 60 C100 62 46 62 26 60 Z"
        fill="#ffffff"
        stroke="#383838"
        strokeWidth="2.2"
      />
    </svg>
  )
}

export function SmallCloudDoodle({ className, style, ...rest }: DoodleProps) {
  return (
    <svg viewBox="0 0 90 44" className={cn("h-10 w-auto", className)} style={style} {...base} {...rest}>
      <path
        d="M16 37 C4 38 3 24 13 22 C10 12 24 8 31 14 C34 3 55 3 59 15 C69 10 82 18 78 27 C90 28 88 38 76 37 C64 38 28 38 16 37 Z"
        fill="#ffffff"
        stroke="#383838"
        strokeWidth="2"
      />
    </svg>
  )
}

export function SparkleDoodle({ className, style, ...rest }: DoodleProps) {
  return (
    <svg viewBox="0 0 40 40" className={cn("h-6 w-auto", className)} style={style} {...base} {...rest}>
      <path d="M20 3 C21 14 26 19 37 20 C26 21 21 26 20 37 C19 26 14 21 3 20 C14 19 19 14 20 3 Z" fill="#ffde00" stroke="#383838" strokeWidth="2" />
    </svg>
  )
}

export function DoorDoodle({ className, style, ...rest }: DoodleProps) {
  return (
    <svg viewBox="0 0 72 90" className={cn("h-16 w-auto", className)} style={style} {...base} {...rest}>
      <path d="M12 10 L50 9 L51 84 L12 85 Z" fill="#ffde00" stroke="#383838" strokeWidth="2.4" />
      <path d="M50 9 L68 2 L69 90 L51 84 Z" fill="#ff9538" stroke="#383838" strokeWidth="2.4" />
      <circle cx="63" cy="48" r="2" fill="#383838" />
      <path d="M4 86 C25 88 50 88 70 86" stroke="#54b4de" strokeWidth="2" strokeDasharray="4 5" />
    </svg>
  )
}

