export type WalletChallengeFields = {
  domain: string; sellerId: string; apiId: string; origin: string;
  payTo: string; network: "cardano:preprod"; nonce: string; expires: string;
};

/** The exact text the seller signs with CIP-30 signData. Line-based, fixed order. */
export function buildWalletChallenge(f: WalletChallengeFields): string {
  for (const [k, v] of Object.entries(f)) {
    if (/[\r\n]/.test(v)) throw new Error(`challenge field ${k} must not contain a line break`);
  }
  if (!f.payTo.startsWith("addr_test1")) throw new Error("payTo must be a preprod address (addr_test1…)");
  if (f.network !== "cardano:preprod") throw new Error("network must be cardano:preprod");
  return [
    "Hirakumi ownership proof",
    `domain: ${f.domain}`,
    `seller: ${f.sellerId}`,
    `api: ${f.apiId}`,
    `origin: ${f.origin}`,
    `payTo: ${f.payTo}`,
    `network: ${f.network}`,
    `nonce: ${f.nonce}`,
    `expires: ${f.expires}`,
  ].join("\n");
}

export function httpChallengePath(apiId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(apiId)) throw new Error(`invalid api id: ${apiId}`);
  return `/.well-known/hirakumi/${apiId}.txt`;
}
