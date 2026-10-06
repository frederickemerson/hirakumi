// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WALLETS_CHANGED } from "./phone-wallet-connect";
import { useWallets } from "./wallet-picker";

const wallet = (name: string) => ({ name, icon: "", apiVersion: "1", enable: async () => ({}) as never });

describe("useWallets", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (window as { cardano?: unknown }).cardano;
  });

  it("picks up a phone wallet that connects after the initial search window", () => {
    vi.useFakeTimers();
    (window as { cardano?: unknown }).cardano = { lace: wallet("Lace") };
    const { result } = renderHook(() => useWallets());
    act(() => { vi.advanceTimersByTime(4_000); });
    expect(result.current?.map((w) => w.name)).toEqual(["Lace"]);
    (window as { cardano?: Record<string, unknown> }).cardano!.eternlp2p = wallet("Eternl (P2P)");
    act(() => { window.dispatchEvent(new Event(WALLETS_CHANGED)); });
    expect(result.current?.map((w) => w.name)).toEqual(["Lace", "Eternl (P2P)"]);
  });
});
