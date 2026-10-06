// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EscrowJob, PackSale } from "@/lib/repo/stats";
import { EscrowJobsTable, PackSalesTable } from "./sales-tables";

const sale: PackSale = {
  id: "ct_1", createdAt: new Date("2026-10-06T10:00:00Z"), payer: "addr_test1qqbuyerbuyerbuyerbuyer", calls: 100,
  priceMicros: "2000000", status: "active", remaining: 99, txHash: "abc123",
};

describe("sales tables", () => {
  it("links each paid pack to Cardanoscan", () => {
    render(<PackSalesTable sales={[sale]} />);
    expect(screen.getByRole("link", { name: "View on Cardanoscan" })).toHaveAttribute("href", "https://preprod.cardanoscan.io/transaction/abc123");
    expect(screen.getByText("2 tUSDM")).toBeInTheDocument();
    expect(screen.getByText("99 of 100 left")).toBeInTheDocument();
    expect(screen.getByText("Paid, credits available")).toBeInTheDocument();
  });

  it("says when a payment has no transaction yet", () => {
    render(<PackSalesTable sales={[{ ...sale, status: "pending", txHash: null }]} />);
    expect(screen.getByText("Not recorded yet")).toBeInTheDocument();
    expect(screen.getByText("Waiting for the payment to settle")).toBeInTheDocument();
  });

  it("has plain-language empty states", () => {
    render(<><PackSalesTable sales={[]} /><EscrowJobsTable jobs={[]} /></>);
    expect(screen.getByText("No pack sales yet")).toBeInTheDocument();
    expect(screen.getByText("No per-job hires yet")).toBeInTheDocument();
  });

  it("explains failed jobs and the automatic refund", () => {
    const job: EscrowJob = { id: "job_1", createdAt: new Date("2026-10-06T10:00:00Z"), status: "failed",
      identifierFromPurchaser: "ref", blockchainIdentifier: null, failureReasons: ["$.price is missing"] };
    render(<EscrowJobsTable jobs={[job]} />);
    expect(screen.getByText("Didn't pass, Masumi refunds the buyer automatically")).toBeInTheDocument();
    expect(screen.getByText("$.price is missing")).toBeInTheDocument();
  });
});
