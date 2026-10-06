import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach } from "vitest";
import { closeSql } from "@/lib/db";
import { TEST_ENV } from "./env";

Object.assign(process.env, TEST_ENV);

afterEach(() => {
  cleanup();
});

afterAll(async () => {
  await closeSql();
});
