// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletPay } from "./wallet-pay";
import { forgetEmailWallet } from "@/lib/utxos-wallet";

const sdk = vi.hoisted(() => ({ enable: vi.fn() }));
vi.mock("@utxos/sdk", () => ({ Web3Wallet: { enable: sdk.enable } }));

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const PREPARED = { tx: "84a3", nonce: `${"ab".repeat(32)}#0`, feeLovelace: "180000", priceMicros: "2000000", calls: 100 };

beforeEach(() => {
  window.cardano = {
    lace: {
      name: "Lace", icon: "", apiVersion: "1",
      enable: async () => ({
        getNetworkId: async () => 0, getChangeAddress: async () => "00ab", getUtxos: async () => ["8282"],
        signTx: async () => "a100", signData: async () => ({ signature: "", key: "" }),
      }),
    },
  } as unknown as typeof window.cardano;
});
afterEach(() => { delete window.cardano; vi.unstubAllGlobals(); });

/** pay answers `pay`; each resume takes the next answer from `resumes`. */
function server(pay: () => Response | Promise<Response>, resumes: (() => Response | Promise<Response>)[]) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    if (url.endsWith("/prepare")) return json(PREPARED);
    if (url.endsWith("/resume")) return (resumes.shift() ?? (() => json({ status: "pending", message: "m" }, 202)))();
    return pay();
  }));
  return urls;
}

describe("WalletPay", () => {
  it("a payment not confirmed yet shows Pending, never an error or 'not charged', and is followed to the pack", async () => {
    const onBought = vi.fn();
    const urls = server(
      () => json({ status: "pending", message: "Your payment is sent and waiting for Cardano to confirm it." }, 202),
      [() => json({ status: "pending", message: "m" }, 202), () => json({ credits: 100, txHash: null, pending: false })],
    );
    render(<WalletPay apiId="api_1" packPrice={{ calls: 100, priceMicros: "2000000" }} onBought={onBought} resumeEveryMs={20} />);
    await userEvent.click(await screen.findByRole("button", { name: "Pay with Lace" }));
    expect(await screen.findByText(/^Pending\. Your payment is sent/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.body.textContent).not.toMatch(/not charged|nothing was paid|failed/i);
    await vi.waitFor(() => expect(onBought).toHaveBeenCalledWith({ credits: 100, txHash: null, pending: false }));
    expect(urls.filter((u) => u.endsWith("/try/pay"))).toHaveLength(1);
  });

  it("a lost connection or platform timeout after signing is pending too; a certain failure from resume is shown", async () => {
    const onBought = vi.fn();
    server(() => new Response("", { status: 504 }), [() => { throw new TypeError("offline"); }, () => json({ error: "Hirakumi never received the payment, so nothing was paid." }, 410)]);
    render(<WalletPay apiId="api_1" packPrice={null} onBought={onBought} resumeEveryMs={20} />);
    await userEvent.click(await screen.findByRole("button", { name: "Pay with Lace" }));
    expect(await screen.findByText(/^Pending\./)).toBeInTheDocument();
    expect(await screen.findByText("Hirakumi never received the payment, so nothing was paid.")).toBeInTheDocument();
    expect(onBought).not.toHaveBeenCalled();
  });
});

describe("WalletPay with the email wallet", () => {
  afterEach(() => { vi.unstubAllEnvs(); sdk.enable.mockReset(); forgetEmailWallet(); });

  it("sends only its address to prepare (the server reads the UTxOs) and asks for the witness set", async () => {
    vi.stubEnv("NEXT_PUBLIC_UTXOS_PROJECT_ID", "proj");
    const signTx = vi.fn(async () => "a100");
    sdk.enable.mockResolvedValue({
      cardano: {
        getNetworkId: async () => 0, getChangeAddress: async () => "00ab", getChangeAddressBech32: async () => "addr_test1qq",
        getUsedAddresses: async () => ["00ab"], signData: async () => ({ signature: "", key: "" }), signTx,
      },
    });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return url.endsWith("/prepare") ? json(PREPARED) : json({ credits: 100, txHash: "tx", pending: false });
    }));
    const onBought = vi.fn();
    const user = userEvent.setup();
    render(<WalletPay apiId="api_1" packPrice={null} onBought={onBought} />);
    expect(await screen.findByRole("button", { name: "Pay with Lace" })).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Continue with email or Google" });
    await user.click(button);
    expect(await screen.findByText(/Your email wallet is connected/)).toBeInTheDocument();
    expect(bodies).toHaveLength(0);
    await user.click(button);
    await vi.waitFor(() => expect(onBought).toHaveBeenCalledWith({ credits: 100, txHash: "tx", pending: false }));
    expect(bodies[0]).toEqual({ changeAddress: "00ab" });
    expect(signTx).toHaveBeenCalledWith(PREPARED.tx, true, false);
    expect(bodies[1]).toMatchObject({ tx: PREPARED.tx, witnessSet: "a100" });
  });

  it("an extension wallet still sends its own UTxOs", async () => {
    vi.stubEnv("NEXT_PUBLIC_UTXOS_PROJECT_ID", "proj");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return url.endsWith("/prepare") ? json(PREPARED) : json({ credits: 100, txHash: null, pending: false });
    }));
    const onBought = vi.fn();
    render(<WalletPay apiId="api_1" packPrice={null} onBought={onBought} />);
    await userEvent.click(await screen.findByRole("button", { name: "Pay with Lace" }));
    await vi.waitFor(() => expect(onBought).toHaveBeenCalled());
    expect(bodies[0]).toEqual({ utxos: ["8282"], changeAddress: "00ab" });
    expect(sdk.enable).not.toHaveBeenCalled();
  });
});
