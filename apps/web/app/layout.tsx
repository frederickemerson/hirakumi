import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { JetBrains_Mono } from "next/font/google";
import { AskHirakumi } from "@/components/ask-hirakumi";
import { RouteProgress } from "@/components/route-progress";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Toaster } from "@/components/toast";
import { cn } from "@/lib/utils";

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Hirakumi", template: "%s | Hirakumi" },
  description: "Make your APIs monetizable. Paste an OpenAPI link or a few example requests, sign with your Cardano wallet, set a pack price. AI agents pay in USDM, and stale or empty answers cost them nothing.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the inline script below adds the `js` class before React hydrates.
    <html lang="en" className={cn("font-sans", mono.variable)} suppressHydrationWarning>
      <head>
        {/* Before first paint: lets CSS hide scroll-reveal content only when JavaScript will reveal it. */}
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      </head>
      <body className="flex min-h-dvh flex-col bg-background text-foreground antialiased">
        <RouteProgress />
        <SiteHeader />
        {/* Pages sit in a centred 1200px column with a 16px gutter. Full-bleed bands use the `bleed` utility. */}
        {/* Extra bottom room below md so the floating Ask button never covers the end of a page. */}
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 pt-10 pb-28 md:pb-10">{children}</main>
        <SiteFooter />
        <Toaster />
        {/* A client island: the general help chat, on every page, kept across navigations. */}
        <AskHirakumi />
      </body>
    </html>
  );
}
