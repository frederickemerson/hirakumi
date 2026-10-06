import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as PlutusV3 from "@evolution-sdk/evolution/PlutusV3";
import * as ScriptHash from "@evolution-sdk/evolution/ScriptHash";
import { PACK_ESCROW } from "../src/index.js";

const blueprint = JSON.parse(
  readFileSync(new URL("../../../contracts/pack-escrow/plutus.json", import.meta.url), "utf8"),
) as { preamble: { plutusVersion: string }; validators: { title: string; hash: string; compiledCode: string }[] };

describe("PACK_ESCROW", () => {
  const spend = blueprint.validators.find((v) => v.title === "pack_escrow.pack_escrow.spend")!;

  it("comes from the committed Plutus V3 blueprint", () => {
    expect(blueprint.preamble.plutusVersion).toBe("v3");
    expect(PACK_ESCROW.scriptCbor).toBe(spend.compiledCode);
    expect(PACK_ESCROW.scriptHash).toBe(spend.hash);
    expect(PACK_ESCROW.scriptHash).toMatch(/^[0-9a-f]{56}$/);
  });

  it("the hash is what x402 derives from script.code (PlutusV3 over compiledCode)", () => {
    const script = new PlutusV3.PlutusV3({ bytes: Buffer.from(PACK_ESCROW.scriptCbor, "hex") });
    expect(ScriptHash.toHex(ScriptHash.fromScript(script))).toBe(PACK_ESCROW.scriptHash);
  });

  it("the preprod address is the enterprise script address (aiken blueprint address)", () => {
    expect(PACK_ESCROW.address).toMatch(/^addr_test1w/);
    expect(PACK_ESCROW.address).toBe("addr_test1wqwqw68rgnnd7z99300njyhkez24yzwx660vxmu0wzpzsscrga9pa");
  });
});
