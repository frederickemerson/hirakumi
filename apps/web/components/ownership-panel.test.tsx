// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { OwnershipPanel } from "./ownership-panel";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const FILE_URL = "https://price.example.dev/.well-known/hirakumi/api_1.txt";

function installWallet(signData = vi.fn(async () => ({ signature: "84a1", key: "a401" }))) {
  window.cardano = {
    eternl: {
      name: "eternl",
      icon: "",
      enable: async () => ({
        getNetworkId: async () => 0,
        getChangeAddress: async () => "00beef",
        getUsedAddresses: async () => ["00beef"],
        signData,
      }),
    },
  };
  return signData;
}

afterEach(() => {
  delete window.cardano;
  vi.unstubAllGlobals();
  nav.push.mockReset();
});

describe("OwnershipPanel", () => {
  it("shows where the file must be served and links the download", () => {
    installWallet();
    render(<OwnershipPanel apiId="api_1" fileUrl={FILE_URL} initiallyPassed={false} />);
    expect(screen.getByText(FILE_URL)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download the file" })).toHaveAttribute("href", "/api/apis/api_1/challenge-file");
  });

  it("shows the URL tried and the reason when the check fails", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ ok: false, triedUrl: FILE_URL, detail: "Got HTTP 404 Not Found." })));
    render(<OwnershipPanel apiId="api_1" fileUrl={FILE_URL} initiallyPassed={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Check" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(`We tried ${FILE_URL}`);
    expect(alert).toHaveTextContent("Got HTTP 404 Not Found.");
    expect(await screen.findByRole("button", { name: "Sign with eternl" })).toBeDisabled();
  });

  it("enables signing after a passing check, signs the server's message and opens Review", async () => {
    const signData = installWallet();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, triedUrl: FILE_URL, detail: "The file matched." }))
      .mockResolvedValueOnce(jsonResponse({ challengeId: "ch_1", message: "Hirakumi ownership\napi: api_1" }))
      .mockResolvedValueOnce(jsonResponse({ state: "ownership_verified" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<OwnershipPanel apiId="api_1" fileUrl={FILE_URL} initiallyPassed={false} />);
    await user.click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByText("Found it. Your file matches.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign with eternl" }));
    await vi.waitFor(() => expect(nav.push).toHaveBeenCalledWith("/apis/api_1/review"));
    expect(signData).toHaveBeenCalledWith("00beef", Buffer.from("Hirakumi ownership\napi: api_1").toString("hex"));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ challengeId: "ch_1", address: "00beef", signature: "84a1", key: "a401" });
  });

  it("shows the gateway outage message", async () => {
    installWallet();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({ error: "We couldn't reach the Hirakumi checker. Try again in a minute." }, 502)));
    render(<OwnershipPanel apiId="api_1" fileUrl={FILE_URL} initiallyPassed={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't reach the Hirakumi checker.");
  });
});
