import type { NextConfig } from "next";

const config: NextConfig = {
  // Mesh pulls in libsodium (WASM); keep it out of the server bundle and load it from node_modules.
  serverExternalPackages: ["@meshsdk/core-cst"],
  // Workspace packages ship TypeScript source. The web uses only @hirakumi/escrow/iou (IOU signing, noble only).
  transpilePackages: ["@hirakumi/core", "@hirakumi/escrow"],
  // Don't write AGENTS.md / CLAUDE.md into the app directory on `next dev`.
  agentRules: false,
};

export default config;
