import { cn } from "cn"

/*
 * Hand-drawn doodles for the landing page. Loose pencil lines in charcoal (#383838) and
 * wet-cement blue (#54b4de); fills in orange and yellow. All decorative (aria-hidden).
 */
type DoodleProps = { className?: string; style?: React.CSSProperties }

const base = { fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const, focusable: "false" as const }

export function CloudDoodle({ className, style }: DoodleProps) {
  return (
    <svg viewBox="0 0 160 70" className={cn("h-16 w-auto", className)} style={style} {...base}>
      <path
        d="M26 60 C8 61 5 40 20 36 C15 22 34 14 46 22 C50 6 82 5 88 24 C104 16 124 28 118 42 C138 43 137 61 118 60 C100 62 46 62 26 60 Z"
        fill="#ffffff"
        stroke="#383838"
        strokeWidth="2.2"
      />
    </svg>
  )
}

export function SmallCloudDoodle({ className, style }: DoodleProps) {
  return (
    <svg viewBox="0 0 90 44" className={cn("h-10 w-auto", className)} style={style} {...base}>
      <path
        d="M16 37 C4 38 3 24 13 22 C10 12 24 8 31 14 C34 3 55 3 59 15 C69 10 82 18 78 27 C90 28 88 38 76 37 C64 38 28 38 16 37 Z"
        fill="#ffffff"
        stroke="#383838"
        strokeWidth="2"
      />
    </svg>
  )
}

export function TriangleDoodle({ className, style }: DoodleProps) {
  return (
    <svg viewBox="0 0 60 54" className={cn("h-10 w-auto", className)} style={style} {...base}>
      <path d="M30 6 L55 48 L5 49 Z" stroke="#54b4de" strokeWidth="2.4" />
      <path d="M30 14 L48 44 L12 45 Z" stroke="#54b4de" strokeWidth="1.4" strokeDasharray="3 4" />
    </svg>
  )
}

export function CoinDoodle({ className, style }: DoodleProps) {
  return (
    <svg viewBox="0 0 64 64" className={cn("h-12 w-auto", className)} style={style} {...base}>
      <ellipse cx="32" cy="33" rx="26" ry="25" fill="#ffde00" stroke="#383838" strokeWidth="2.2" />
      <ellipse cx="32" cy="33" rx="18" ry="17" stroke="#383838" strokeWidth="1.6" strokeDasharray="5 4" />
      <path d="M26 24 C33 20 41 25 36 31 C32 35 28 36 29 42 M27 44 L37 43" stroke="#383838" strokeWidth="2.2" />
      <path d="M14 20 C18 15 23 12 29 11" stroke="#ffffff" strokeWidth="2.4" />
    </svg>
  )
}

export function AgentDoodle({ className, style }: DoodleProps) {
  return (
    <svg viewBox="0 0 80 96" className={cn("h-20 w-auto", className)} style={style} {...base}>
      {/* antenna */}
      <path d="M40 16 L41 6" stroke="#383838" strokeWidth="2.2" />
      <circle cx="41" cy="5" r="3" fill="#ff9538" stroke="#383838" strokeWidth="1.8" />
      {/* head */}
      <path d="M18 18 L62 17 L63 46 L19 47 Z" fill="#ffffff" stroke="#383838" strokeWidth="2.4" />
      <rect x="27" y="27" width="8" height="8" fill="#383838" />
      <rect x="45" y="26" width="8" height="8" fill="#383838" />
      <path d="M30 40 C35 43 45 43 50 40" stroke="#383838" strokeWidth="2" />
      {/* body */}
      <path d="M24 52 L56 51 L58 80 L23 81 Z" fill="#6fc2ff" stroke="#383838" strokeWidth="2.4" />
      <path d="M31 60 L49 59 M31 67 L45 67" stroke="#383838" strokeWidth="1.6" />
      {/* arms and legs */}
      <path d="M23 58 C12 60 10 68 14 74 M57 57 C68 59 70 66 66 72" stroke="#383838" strokeWidth="2.2" />
      <path d="M31 82 L30 92 M50 82 L51 92" stroke="#383838" strokeWidth="2.2" />
      <path d="M24 92 L36 92 M45 92 L57 92" stroke="#383838" strokeWidth="2.4" />
    </svg>
  )
}

export function SparkleDoodle({ className, style }: DoodleProps) {
  return (
    <svg viewBox="0 0 40 40" className={cn("h-6 w-auto", className)} style={style} {...base}>
      <path d="M20 3 C21 14 26 19 37 20 C26 21 21 26 20 37 C19 26 14 21 3 20 C14 19 19 14 20 3 Z" fill="#ffde00" stroke="#383838" strokeWidth="2" />
    </svg>
  )
}

export function DoorDoodle({ className, style }: DoodleProps) {
  return (
    <svg viewBox="0 0 72 90" className={cn("h-16 w-auto", className)} style={style} {...base}>
      <path d="M12 10 L50 9 L51 84 L12 85 Z" fill="#ffde00" stroke="#383838" strokeWidth="2.4" />
      <path d="M50 9 L68 2 L69 90 L51 84 Z" fill="#ff9538" stroke="#383838" strokeWidth="2.4" />
      <circle cx="63" cy="48" r="2" fill="#383838" />
      <path d="M4 86 C25 88 50 88 70 86" stroke="#54b4de" strokeWidth="2" strokeDasharray="4 5" />
    </svg>
  )
}

export function ArrowDoodle({ className, style }: DoodleProps) {
  return (
    <svg viewBox="0 0 64 32" className={cn("h-5 w-auto", className)} style={style} {...base}>
      <path d="M4 17 C20 12 40 14 58 16" stroke="#383838" strokeWidth="2.2" />
      <path d="M48 7 L59 16 L47 25" stroke="#383838" strokeWidth="2.2" />
    </svg>
  )
}

export function SquiggleDoodle({ className, style }: DoodleProps) {
  return (
    <svg viewBox="0 0 120 20" className={cn("h-3 w-auto", className)} style={style} {...base}>
      <path d="M2 12 C12 2 20 2 30 12 S48 22 58 12 S76 2 86 12 S104 22 118 10" stroke="#54b4de" strokeWidth="2.4" />
    </svg>
  )
}
