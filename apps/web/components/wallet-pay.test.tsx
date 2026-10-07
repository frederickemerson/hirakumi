// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletPay } from "./wallet-pay";

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
