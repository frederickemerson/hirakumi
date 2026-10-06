import { generateUpstreamAuthKeys } from "@hirakumi/core";

// A new keypair for keys sellers give to APIs that need one. The public half goes to the web app (it seals each
// key), the private half to the gateway only (it opens them). A new pair makes every stored key unreadable, so the
// sellers of those APIs must enter their keys again.
const { publicKey, privateKey } = generateUpstreamAuthKeys();
console.log(`UPSTREAM_AUTH_PUBLIC_KEY=${publicKey}`);
console.log(`UPSTREAM_AUTH_PRIVATE_KEY=${privateKey}`);
