// The committed Aiken blueprint (contracts/pack-escrow/plutus.json).
import blueprint from "../../../contracts/pack-escrow/plutus.json" with { type: "json" };
import { buildAddress } from "./address.js";

const spend = blueprint.validators.find((v) => v.title === "pack_escrow.pack_escrow.spend");
if (!spend) throw new Error("plutus.json has no pack_escrow.pack_escrow.spend");

export const PACK_ESCROW = {
  /** `compiledCode` from the blueprint: what x402's `extra.script.code` takes (type "plutusV3"). */
  scriptCbor: spend.compiledCode,
  scriptHash: spend.hash,
  /** Enterprise script address on preprod. */
  address: buildAddress(0, { kind: "script", hash: spend.hash }),
  plutusVersion: "plutusV3",
} as const;
