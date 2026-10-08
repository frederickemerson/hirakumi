/**
 * The email or Google wallet: UTXOS (utxos.dev, by the Mesh team), a non-custodial Cardano wallet the seller
 * opens with Google or an email code. Each signature opens a utxos.dev window where the key is rebuilt.
 *
 * The adapter gives the rest of the app the same CIP-30 shape as a browser extension, so sign-in, ownership and
 * the server's signature check stay as they are. What differs from an extension, all handled here:
 * - signData takes a bech32 address (Mesh headless wallet), while our flows pass the CIP-30 hex one.
 * - signTx returns the full transaction unless told otherwise; the payment flow needs the witness set.
 * - It can't list its UTxOs (the SDK does not hand our fetcher to the Cardano wallet in 0.2.8), so it has no
 *   getUtxos and the server reads them at its address instead.
 * - Its errors carry the CIP-30 code in `json.code`; ours read `code`.
 * - Every call opens a window, and a browser only allows that straight from a click. Opening the wallet uses up
 *   the click, so the first connect asks for one more click before anything is signed.
 */

/** The SDK surface we use, read from @utxos/sdk 0.2.8's types (Web3Wallet.enable, MeshCardanoHeadlessWallet). */
export type UtxosCardano = {
  getNetworkId(): Promise<number>;
  getChangeAddress(): Promise<string>;
  getChangeAddressBech32(): Promise<string>;
  getUsedAddresses(): Promise<string[]>;
  signData(addressBech32: string, payloadHex: string): Promise<{ signature: string; key: string }>;
  signTx(tx: string, partialSign?: boolean, returnFullTx?: boolean): Promise<string>;
};
export type UtxosSdk = {
  Web3Wallet: { enable(options: { projectId: string; networkId: 0 | 1 }): Promise<{ cardano: UtxosCardano }> };
};

/** What the payment and sign-in flows call. No getUtxos: see above. */
export type EmailWalletApi = {
  getNetworkId(): Promise<number>;
  getChangeAddress(): Promise<string>;
  getUsedAddresses(): Promise<string[]>;
  signData(addr: string, payloadHex: string): Promise<{ signature: string; key: string }>;
  signTx(tx: string, partialSign: boolean): Promise<string>;
};

/** The first connect used up the click; the person clicks once more to sign. Not a failure. */
export class ClickAgainError extends Error {}

export class EmailWalletError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

const EMAIL_WALLET_CLICK_AGAIN = "Your email wallet is connected. Click Continue with email or Google again to approve.";
/** The SDK's ApiError keeps the CIP-30 code in json.code: lift it to `code`, where walletErrorMessage reads it. */
function normalize(e: unknown): unknown {
  if (e instanceof EmailWalletError || e instanceof ClickAgainError) return e;
  const code = (e as { json?: { code?: unknown } } | null)?.json?.code;
  if (typeof code === "number") return new EmailWalletError(e instanceof Error ? e.message : "", code);
  return e;
}

async function call<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    throw normalize(e);
  }
}

export function adaptUtxosWallet(cardano: UtxosCardano): EmailWalletApi {
  return {
    getNetworkId: () => call(() => cardano.getNetworkId()),
    getChangeAddress: () => call(() => cardano.getChangeAddress()),
    getUsedAddresses: () => call(() => cardano.getUsedAddresses()),
    async signData(addr, payloadHex) {
      // It is a single-address wallet: the only address it can sign for is its own.
      const own = await call(() => cardano.getChangeAddress());
      if (addr.toLowerCase() !== own.toLowerCase()) throw new EmailWalletError("This wallet can only sign with its own address.", 1);
      const bech32 = await call(() => cardano.getChangeAddressBech32());
      return call(() => cardano.signData(bech32, payloadHex));
    },
    // returnFullTx false: the witness set, as CIP-30 signTx returns it.
    signTx: (tx, partialSign) => call(() => cardano.signTx(tx, partialSign, false)),
  };
}

let connected: { projectId: string; api: EmailWalletApi } | null = null;

/** Tests only. */
export function forgetEmailWallet() {
  connected = null;
}

/**
 * The email wallet, connected once per page session. The first call opens the sign-in window and then throws
 * ClickAgainError, because the browser blocks a second window from the same click.
 */
export async function connectEmailWallet(
  projectId: string,
  loadSdk: () => Promise<UtxosSdk> = () => import("@utxos/sdk") as unknown as Promise<UtxosSdk>,
): Promise<EmailWalletApi> {
  if (connected?.projectId === projectId) return connected.api;
  const sdk = await loadSdk();
  const wallet = await call(() => sdk.Web3Wallet.enable({ projectId, networkId: 0 }));
  connected = { projectId, api: adaptUtxosWallet(wallet.cardano) };
  throw new ClickAgainError(EMAIL_WALLET_CLICK_AGAIN);
}
