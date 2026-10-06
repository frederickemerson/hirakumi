import { registryLinks } from "@/lib/try";

/** Where this agent lives: its Masumi registry entry on Cardano preprod and its MIP-003 endpoints. */
export function RegistryCard({ agentIdentifier, agentBaseUrl }: { agentIdentifier: string | null; agentBaseUrl: string }) {
  const reg = registryLinks(agentIdentifier);
  return (
    <section aria-labelledby="registry-heading" className="space-y-3 rounded-lg border p-4">
      <h2 id="registry-heading" className="text-lg font-semibold">On the Masumi registry</h2>
      {reg ? (
        <>
          <p className="text-sm">
            This API is registered as an agent on Cardano preprod. Its registry entry is a token anyone can look up.
          </p>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-muted-foreground">Agent identifier</dt>
              <dd className="break-all font-mono text-xs">{agentIdentifier}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Registry policy</dt>
              <dd className="break-all font-mono text-xs">{reg.policyId}</dd>
            </div>
          </dl>
          <a href={reg.explorerUrl} target="_blank" rel="noreferrer" className="inline-block text-sm underline">
            See it on the Cardano preprod explorer
          </a>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">The registry entry is still being created.</p>
      )}
      <div className="space-y-1 text-sm">
        <p className="text-muted-foreground">Endpoints any Masumi agent can call</p>
        <ul className="space-y-1 font-mono text-xs">
          <li><a className="underline" href={`${agentBaseUrl}/availability`} target="_blank" rel="noreferrer">GET {agentBaseUrl}/availability</a></li>
          <li><a className="underline" href={`${agentBaseUrl}/input_schema`} target="_blank" rel="noreferrer">GET {agentBaseUrl}/input_schema</a></li>
          <li>POST {agentBaseUrl}/start_job</li>
        </ul>
      </div>
    </section>
  );
}
