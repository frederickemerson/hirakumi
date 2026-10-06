// bech32 address <-> Plutus `Address` data:
//   Address    = Constr 0 [payment: Credential, stake: Option<StakeCredential>]
//   Credential = VerificationKey Constr 0 [bytes28] | Script Constr 1 [bytes28]
//   Option     = Some Constr 0 [x] | None Constr 1 []
//   StakeCredential = Inline Constr 0 [Credential]   (pointers are not supported)
import * as Address from "@evolution-sdk/evolution/Address";
import * as Data from "@evolution-sdk/evolution/Data";
import * as KeyHash from "@evolution-sdk/evolution/KeyHash";
import * as ScriptHash from "@evolution-sdk/evolution/ScriptHash";
import { toHex } from "./hex.js";

export type Credential = { kind: "key" | "script"; hash: string };
export type ParsedAddress = { networkId: number; payment: Credential; stake?: Credential; bytes: Uint8Array };

function cred(c: KeyHash.KeyHash | ScriptHash.ScriptHash): Credential {
  return c instanceof KeyHash.KeyHash
    ? { kind: "key", hash: KeyHash.toHex(c) }
    : { kind: "script", hash: ScriptHash.toHex(c as ScriptHash.ScriptHash) };
}

function evoCred(c: Credential): KeyHash.KeyHash | ScriptHash.ScriptHash {
  return c.kind === "key" ? KeyHash.fromHex(c.hash) : ScriptHash.fromHex(c.hash);
}

/** Base or enterprise Shelley address only. Throws on anything else (pointer, Byron, garbage). */
export function parseAddress(name: string, bech32: string): ParsedAddress {
  let a: Address.Address;
  try {
    a = Address.fromBech32(bech32);
  } catch {
    throw new Error(`${name} is not a base or enterprise Shelley address`);
  }
  return {
    networkId: a.networkId,
    payment: cred(a.paymentCredential),
    stake: a.stakingCredential ? cred(a.stakingCredential) : undefined,
    bytes: Address.toBytes(a),
  };
}

export function buildAddress(networkId: number, payment: Credential, stake?: Credential): string {
  return Address.toBech32(
    new Address.Address({
      networkId,
      paymentCredential: evoCred(payment),
      stakingCredential: stake ? evoCred(stake) : undefined,
    }),
  );
}

const credData = (c: Credential) => Data.constr(c.kind === "key" ? 0n : 1n, [Data.bytearray(c.hash)]);

export function addressToData(name: string, bech32: string): Data.Data {
  const a = parseAddress(name, bech32);
  const stake = a.stake ? Data.constr(0n, [Data.constr(0n, [credData(a.stake)])]) : Data.constr(1n, []);
  return Data.constr(0n, [credData(a.payment), stake]);
}

function constr(name: string, d: Data.Data, index: bigint, arity: number): readonly Data.Data[] {
  if (!Data.isConstr(d) || d.index !== index || d.fields.length !== arity) {
    throw new Error(`${name}: expected Constr ${index} with ${arity} fields`);
  }
  return d.fields;
}

function credFromData(name: string, d: Data.Data): Credential {
  if (!Data.isConstr(d) || d.fields.length !== 1 || (d.index !== 0n && d.index !== 1n)) {
    throw new Error(`${name}: bad credential`);
  }
  const h = d.fields[0];
  if (!(h instanceof Uint8Array) || h.length !== 28) throw new Error(`${name}: credential hash must be 28 bytes`);
  return { kind: d.index === 0n ? "key" : "script", hash: toHex(h) };
}

export function addressFromData(name: string, d: Data.Data, networkId: number): string {
  const [payment, stake] = constr(name, d, 0n, 2);
  let stakeCred: Credential | undefined;
  if (Data.isConstr(stake!) && stake.index === 0n) {
    const [inline] = constr(`${name}.stake`, stake, 0n, 1);
    const [c] = constr(`${name}.stake (pointers unsupported)`, inline!, 0n, 1);
    stakeCred = credFromData(`${name}.stake`, c!);
  } else {
    constr(`${name}.stake`, stake!, 1n, 0);
  }
  return buildAddress(networkId, credFromData(`${name}.payment`, payment!), stakeCred);
}
