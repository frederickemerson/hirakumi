import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptUtxosWallet, ClickAgainError, connectEmailWallet, EmailWalletError, forgetEmailWallet, type UtxosCardano, type UtxosSdk } from "./utxos-wallet";

const HEX = "00aabb";
const BECH32 = "addr_test1qexample";

/** The SDK's ApiError: an Error with the CIP-30 code in json.code. */
const apiError = (code: number, info: string) => Object.assign(new Error(info), { name: "ApiError", json: { code, info } });

function fakeCardano(over: Partial<UtxosCardano> = {}): UtxosCardano {
  return {
    getNetworkId: vi.fn(async () => 0),
    getChangeAddress: vi.fn(async () => HEX),
    getChangeAddressBech32: vi.fn(async () => BECH32),
    getUsedAddresses: vi.fn(async () => [HEX]),
    signData: vi.fn(async () => ({ signature: "84a1", key: "a401" })),
    signTx: vi.fn(async () => "a100"),
    ...over,
  };
}

afterEach(() => forgetEmailWallet());

describe("adaptUtxosWallet", () => {
  it("signs data with the wallet's bech32 address, given the CIP-30 hex one, and returns the Mesh DataSignature as is", async () => {
    const c = fakeCardano();
    const sig = await adaptUtxosWallet(c).signData(HEX, "6869");
    expect(c.signData).toHaveBeenCalledWith(BECH32, "6869");
    expect(sig).toEqual({ signature: "84a1", key: "a401" });
  });

  it("refuses to sign for an address that isn't its own", async () => {
    const c = fakeCardano();
    await expect(adaptUtxosWallet(c).signData("00ffff", "6869")).rejects.toBeInstanceOf(EmailWalletError);
    expect(c.signData).not.toHaveBeenCalled();
  });

  it("asks signTx for the witness set (returnFullTx false), keeping partialSign", async () => {
    const c = fakeCardano();
    expect(await adaptUtxosWallet(c).signTx("84a3", true)).toBe("a100");
    expect(c.signTx).toHaveBeenCalledWith("84a3", true, false);
  });

  it("lifts the SDK's json.code to code, so the CIP-30 messages apply", async () => {
    const c = fakeCardano({ signData: vi.fn(async () => { throw apiError(3, "UserDeclined"); }), signTx: vi.fn(async () => { throw apiError(2, "UserDeclined"); }) });
    const api = adaptUtxosWallet(c);
    await expect(api.signData(HEX, "68")).rejects.toMatchObject({ code: 3 });
    await expect(api.signTx("84", true)).rejects.toMatchObject({ code: 2 });
  });

  it("has no getUtxos: the server reads the UTxOs at the address", () => {
    expect("getUtxos" in adaptUtxosWallet(fakeCardano())).toBe(false);
  });
});

describe("connectEmailWallet", () => {
  it("opens the wallet on preprod once, asks for another click, then reuses the connection", async () => {
    const c = fakeCardano();
    const enable = vi.fn(async () => ({ cardano: c }));
    const load = vi.fn(async (): Promise<UtxosSdk> => ({ Web3Wallet: { enable } }));
    await expect(connectEmailWallet("proj", load)).rejects.toBeInstanceOf(ClickAgainError);
    expect(enable).toHaveBeenCalledWith({ projectId: "proj", networkId: 0 });
    const api = await connectEmailWallet("proj", load);
    expect(await api.getChangeAddress()).toBe(HEX);
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("a refused connection keeps its CIP-30 code and connects nothing", async () => {
    const enable = vi.fn(async () => { throw apiError(-3, "Refused"); });
    const load = async (): Promise<UtxosSdk> => ({ Web3Wallet: { enable } });
    await expect(connectEmailWallet("proj", load)).rejects.toMatchObject({ code: -3 });
    await expect(connectEmailWallet("proj", load)).rejects.toMatchObject({ code: -3 });
    expect(enable).toHaveBeenCalledTimes(2);
  });
});
