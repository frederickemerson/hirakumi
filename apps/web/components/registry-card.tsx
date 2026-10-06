import { registryLinks } from "@/lib/try";

/** Where this agent lives: its Masumi registry entry on Cardano preprod and its MIP-003 endpoints. */
export function RegistryCard({ agentIdentifier, agentBaseUrl }: { agentIdentifier: string | null; agentBaseUrl: string }) {
  const reg = registryLinks(agentIdentifier);
  return (
    <section aria-labelledby="registry-heading" className="space-y-4 rounded-[2px] border-2 border-ink bg-frost p-5 sm:p-6">
      <h2 id="registry-heading" className="text-sub font-semibold uppercase">On the Masumi registry</h2>
      {reg ? (
        <>
          <p className="text-body">
            This API is registered as an agent on Cardano preprod. Its registry entry is a token anyone can look up.
          </p>
          <dl className="grid gap-4 text-body md:grid-cols-2">
            <div>
              <dt className="text-caption uppercase tracking-[0.04em] text-graphite">Agent identifier</dt>
              <dd className="mt-1 break-all text-caption">{agentIdentifier}</dd>
            </div>
            <div>
              <dt className="text-caption uppercase tracking-[0.04em] text-graphite">Registry policy</dt>
              <dd className="mt-1 break-all text-caption">{reg.policyId}</dd>
            </div>
          </dl>
          <a href={reg.explorerUrl} target="_blank" rel="noreferrer" className="inline-block text-body underline underline-offset-4">
            See it on the Cardano preprod explorer
          </a>
        </>
      ) : (
        <p className="text-body text-graphite">The registry entry is still being created.</p>
      )}
      <div className="space-y-2 border-t border-ink pt-4 text-body">
        <p className="text-caption uppercase tracking-[0.04em] text-graphite">Endpoints any Masumi agent can call</p>
        <ul className="space-y-1 text-caption">
          <li><a className="underline underline-offset-4" href={`${agentBaseUrl}/availability`} target="_blank" rel="noreferrer">GET {agentBaseUrl}/availability</a></li>
          <li><a className="underline underline-offset-4" href={`${agentBaseUrl}/input_schema`} target="_blank" rel="noreferrer">GET {agentBaseUrl}/input_schema</a></li>
          <li>POST {agentBaseUrl}/start_job</li>
        </ul>
      </div>
    </section>
  );
}
