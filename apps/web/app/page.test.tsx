// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Home from "./page";

describe("Home", () => {
  it("invites the seller to list an API", () => {
    render(<Home />);
    expect(screen.getByRole("heading", { name: "Put your API on the agent market" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/login");
  });
});
