import { redirect } from "next/navigation";
import { stepForState } from "@/lib/flow";
import { loadApiPage } from "@/lib/page-auth";

export default async function ApiStepRouter({ params }: { params: Promise<{ apiId: string }> }) {
  const { apiId } = await params;
  const { api } = await loadApiPage(apiId, `/apis/${apiId}`);
  redirect(`/apis/${apiId}/${stepForState(api.state)}`);
}
