import { jcs } from "./jcs";
import { sha256Hex } from "./ids";

/** MIP-004 input hash: sha256(identifier + ";" + JCS(input)), lowercase hex. */
export function inputHash(identifier: string, input: unknown): string {
  return sha256Hex(`${identifier};${jcs(input)}`);
}

/** MIP-004 output hash: sha256(identifier + ";" + raw output string), lowercase hex. */
export function outputHash(identifier: string, raw: string): string {
  return sha256Hex(`${identifier};${raw}`);
}
