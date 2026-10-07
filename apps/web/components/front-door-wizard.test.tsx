// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/http";
import { frontDoorRecord, undoMessage, undoSteps } from "@/lib/front-door";
import { DirectCallerCard, FrontDoorWizard, partsKeyBody, type FrontDoorWizardProps } from "./front-door-wizard";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => nav }));

const TARGET = { cname: "52-70-235-103.sslip.io", a: "52.70.235.103", aaaa: null };
const base: FrontDoorWizardProps = {
  apiId: "api_1", publicHost: "api.seller.dev", origin: "https://api.seller.dev", code: "hkv_code", domain: null,
  dnsTarget: TARGET, apex: false, keyHint: { in: "header", name: "X-API-Key" },
};

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("FrontDoorWizard", () => {
  it("shows the TXT record for the new origin, then sends the origin and key and shows why it didn't switch", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      error: "Test calls to the new origin did not all pass.", reason: "tests_failed",
      tests: [{ opId: "getPrice", ok: false, detail: "upstream answered 401" }],
    }, 422));
    vi.stubGlobal("fetch", fetchMock);
    render(<FrontDoorWizard {...base} />);
    await userEvent.type(screen.getByLabelText("New origin"), "https://origin.seller.dev");
    expect(screen.getByText("_hirakumi.origin.seller.dev")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test and switch" }).hasAttribute("disabled")).toBe(true);
    await userEvent.type(screen.getByLabelText("Key"), "sk_secret");
    await userEvent.click(screen.getByRole("button", { name: "Test and switch" }));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/apis/api_1/front-door/origin");
    expect(JSON.parse(init.body as string)).toEqual({ origin: "https://origin.seller.dev", key: { in: "header", name: "X-API-Key", value: "sk_secret" } });
    expect(await screen.findByText("Test calls to the new origin did not all pass.")).toBeTruthy();
    expect(screen.getByText("getPrice: upstream answered 401")).toBeTruthy();
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("a key stored in several parts asks for every part again and sends the matching preset", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true, host: "api.seller.dev" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FrontDoorWizard {...base} keyHint={null}
      keyParts={[{ in: "header", name: "X-API-Key" }, { in: "header", name: "Notion-Version", fixed: true }]} />);
    await userEvent.type(screen.getByLabelText("New origin"), "https://origin.seller.dev");
    expect(screen.queryByRole("radiogroup", { name: "Where the key goes" })).toBeNull();
    await userEvent.type(screen.getByLabelText("Header X-API-Key"), "sk_secret_0123");
    expect(screen.getByRole("button", { name: "Test and switch" }).hasAttribute("disabled")).toBe(true);
    await userEvent.type(screen.getByLabelText("Header Notion-Version (fixed text)"), "2022-06-28");
    await userEvent.click(screen.getByRole("button", { name: "Test and switch" }));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      origin: "https://origin.seller.dev",
      key: { preset: "keyPlusFixed", fields: { rows: [
        { in: "header", name: "X-API-Key", value: "sk_secret_0123", fixed: false },
        { in: "header", name: "Notion-Version", value: "2022-06-28", fixed: true },
      ] } },
    });
  });

  it("partsKeyBody: one part is Basic with a password, a query part is a header and a query, else two headers", () => {
    expect(partsKeyBody([{ in: "header", name: "Authorization" }], ["alice", "s3cr3tpass"]))
      .toEqual({ preset: "basic", fields: { username: "alice", password: "s3cr3tpass" } });
    expect(partsKeyBody([{ in: "header", name: "a" }, { in: "query", name: "b" }], ["x", "y"])).toMatchObject({ preset: "headerPlusQuery" });
    expect(partsKeyBody([{ in: "header", name: "a" }, { in: "header", name: "b" }], ["x", "y"])).toMatchObject({ preset: "twoHeaders" });
  });

  it("once the origin moved: the CNAME to add, the warnings, and Check connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: false, outcome: "not_routed", detail: "api.seller.dev still points at 1.2.3.4 (A), which is not Hirakumi.", chain: [], addresses: ["1.2.3.4"] })));
    render(<FrontDoorWizard {...base} origin="https://origin.seller.dev" domain={{ status: "pending_dns", lastError: null }} />);
    expect(screen.getByText("CNAME")).toBeTruthy();
    expect(screen.getByText("52-70-235-103.sslip.io")).toBeTruthy();
    expect(screen.getByText(/Remove any AAAA record/)).toBeTruthy();
    expect(screen.getByText(/DNS only \(grey cloud\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Check connection" }));
    expect(await screen.findByText(/still points at 1.2.3.4/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop using the front door" })).toBeTruthy();
  });

  it("an apex hostname gets an A record", () => {
    render(<FrontDoorWizard {...base} publicHost="seller.dev" apex domain={{ status: "pending_dns", lastError: null }} />);
    expect(screen.getByText("52.70.235.103")).toBeTruthy();
    expect(screen.queryByText("52-70-235-103.sslip.io")).toBeNull();
  });

  it("all copy is free of em and en dashes", () => {
    const { container } = render(<>
      <FrontDoorWizard {...base} domain={{ status: "active", lastError: null }} />
      <DirectCallerCard publicHost="api.seller.dev" origin="https://origin.seller.dev" status={null} hasKey={false} />
      <DirectCallerCard publicHost="api.seller.dev" origin="https://origin.seller.dev" status="active" hasKey />
    </>);
    expect(container.textContent).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("lib/front-door", () => {
  it("lists only what applies to undo", () => {
    expect(undoSteps({ frontDoorHost: null, hadKey: false })).toEqual([]);
    expect(undoSteps({ frontDoorHost: "api.x.dev", hadKey: false })).toHaveLength(1);
    const both = undoSteps({ frontDoorHost: "api.x.dev", hadKey: true });
    expect(both).toHaveLength(2);
    expect(undoMessage("Price API", both)).toMatch(/^Price API is no longer sold through Hirakumi\. .*\(1\) .*\(2\) /);
    expect(both.join(" ")).not.toMatch(/[\u2013\u2014]/);
  });
  it("picks CNAME, or A for an apex", () => {
    expect(frontDoorRecord("api.x.dev", TARGET, false)).toEqual({ type: "CNAME", value: "52-70-235-103.sslip.io" });
    expect(frontDoorRecord("x.dev", TARGET, true)).toEqual({ type: "A", value: "52.70.235.103" });
    expect(frontDoorRecord("x.dev", { cname: null, a: null }, true)).toBeNull();
  });
});
