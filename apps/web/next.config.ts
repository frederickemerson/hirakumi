import type { NextConfig } from "next";

const config: NextConfig = {
  // Mesh pulls in libsodium (WASM); keep it out of the server bundle and load it from node_modules.
  serverExternalPackages: ["@meshsdk/core-cst"],
  // @hirakumi/core may ship TypeScript source from the workspace.
  transpilePackages: ["@hirakumi/core"],
  // Don't write AGENTS.md / CLAUDE.md into the app directory on `next dev`.
  agentRules: false,
};

export default config;
