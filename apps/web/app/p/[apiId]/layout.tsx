import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { loadLiveApi } from "@/lib/public-api";

/**
 * Checks the API exists before anything streams. A layout renders outside its segment's loading.tsx, so an
 * unknown id answers with a real 404 status; inside the loading boundary the 200 would already be sent.
 */
export default async function PublicApiLayout({ children, params }: { children: ReactNode; params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  if (!(await loadLiveApi(apiId))) notFound();
  return children;
}
