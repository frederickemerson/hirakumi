import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { JetBrains_Mono } from "next/font/google";
import { RouteProgress } from "@/components/route-progress";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { cn } from "@/lib/utils";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Hirakumi", template: "%s | Hirakumi" },
  description: "Sell your API to AI agents. Paste an OpenAPI link; agents buy call packs in USDM on Cardano and pay only for answers that keep your promise.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={cn("font-sans", mono.variable)}>
      <body className="flex min-h-dvh flex-col bg-background text-foreground antialiased">
        <RouteProgress />
        <SiteHeader />
        {/* Pages sit in a centred 1200px column with a 16px gutter. Full-bleed bands use the `bleed` utility. */}
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-10">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
