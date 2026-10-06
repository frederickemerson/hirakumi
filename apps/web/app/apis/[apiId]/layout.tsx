import type { ReactNode } from "react";
import { ApiNav } from "@/components/api-nav";

export default async function ApiLayout({ children, params }: { children: ReactNode; params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  return (
    <div className="space-y-6">
      <ApiNav apiId={apiId} />
      {children}
    </div>
  );
}
