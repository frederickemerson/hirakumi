import { formatTusdm } from "./money";

export type SnippetInput = {
  gatewayBaseUrl: string;
  apiId: string;
  packId: string;
  packCalls: number;
  packPriceMicros: string;
  opId: string;
  method: string;
  /** The promise's answers are text (CSV, XML...), so the snippet reads the answer as text. */
  textAnswer?: boolean;
};

/** Buyer integration in under 20 lines with the standard x402 client (US6). Strings are single-quoted on purpose: the output contains template literals. */
export function buildBuyerSnippet(i: SnippetInput): string {
  const price = formatTusdm(i.packPriceMicros);
  const base = `${i.gatewayBaseUrl.replace(/\/+$/, "")}/a/${i.apiId}`;
  const method = i.method.toUpperCase();
  const isGet = method === "GET";
  const callInit = isGet
    ? '{ headers: { Authorization: `Bearer ${token}` } }'
    : '{ method: "' + method + '", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input) }';
  return [
    "// npm i @x402/fetch@2.26.0 @x402/cardano@2.26.0",
    'import { wrapFetchWithPayment, x402Client } from "@x402/fetch";',
    'import { toClientCardanoSigner } from "@x402/cardano";',
    'import { ExactCardanoScheme } from "@x402/cardano/exact/client";',
    "",
    `const base = "${base}";`,
    'const signer = toClientCardanoSigner({ mnemonic: process.env.MNEMONIC!, network: "cardano:preprod",',
    '  provider: { blockfrost: { baseUrl: "https://cardano-preprod.blockfrost.io/api/v0", projectId: process.env.BLOCKFROST_PROJECT_ID } } });',
    'const client = new x402Client().register("cardano:preprod", new ExactCardanoScheme(signer))',
    `  .setSpendControls({ maxAmountPerPayment: "$${price}" }); // never pay more than one pack`,
    "const payFetch = wrapFetchWithPayment(fetch, client);",
    `// one payment buys ${i.packCalls} credits for ${price} tUSDM`,
    'const { token } = await (await payFetch(`${base}/packs/' + i.packId + '`, { method: "POST" })).json();',
    ...(isGet ? [] : ["const input = {}; // your request body"]),
    "// 200 uses one credit; 422 means the promise wasn't met and no credit was used",
    'const res = await fetch(`${base}/x/' + i.opId + "`, " + callInit + ");",
    'console.log(res.status, res.headers.get("x-credits-remaining"), await res.' + (i.textAnswer ? "text" : "json") + "());",
  ].join("\n");
}
