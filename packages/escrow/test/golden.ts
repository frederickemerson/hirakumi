// Golden vectors shared with contracts/pack-escrow/lib/hirakumi/{fixtures,golden.test}.ak.
// Change one side, change the other in the same commit.
import type { PackDatum } from "../src/index.js";

/** Fixed IOU secret key 0x0102…20. */
export const GOLDEN_SK = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString("hex");
export const GOLDEN_PK = "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664";
export const CHANNEL = "00".repeat(31) + "01";
/** IOU for CHANNEL, accepted 7. Verified inside Aiken: golden.test.ak `ts_signed_iou_verifies_with_the_builtin`. */
export const SIG_7 =
  "cad601bc32747bf1e603e1b2cdd0a3bbb487b790b7e89c270ec6991f04ca7f0a3ee744595dff9ae7a395a4028bc061f8ae6d7c86c7ba5d10d7844e1088c1ba08";
export const IOU_7_MESSAGE = "484b5231" + CHANNEL + "0000000000000007";

/** Base address: payment key b1…, stake key b5…  */
export const BUYER = "addr_test1qzcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd3kxcmrvd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6mtdd4kk6sfs370w";
/** Enterprise address, payment key 5e… */
export const SELLER = "addr_test1vp09uhj7te09uhj7te09uhj7te09uhj7te09uhj7te09uhsgy423y";
/** Enterprise address, payment key fe… */
export const FEE = "addr_test1vrl0alh7lml0alh7lml0alh7lml0alh7lml0alh7lml0alsu6gx0s";
/** Script payment credential 5c… (NOT the escrow; any script). */
export const SCRIPT_ADDR = "addr_test1wpw9chzut3w9chzut3w9chzut3w9chzut3w9chzut3w9chqzhh58g";

export const USDM_POLICY = "e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9";
export const USDM_NAME = "0014df10745553444d";

/** fixtures.datum(Open) in Aiken. */
export function goldenDatum(): PackDatum {
  return {
    channelId: CHANNEL,
    receiptKey: GOLDEN_PK,
    buyerRefund: BUYER,
    seller: SELLER,
    policyId: USDM_POLICY,
    assetName: USDM_NAME,
    pricePerCall: 20_000n,
    maxCalls: 100n,
    ruleHash: "ab".repeat(32),
    feeAddress: FEE,
    feeBps: 300n,
    closer: "c1".repeat(28),
    contestPeriod: 3_600_000n,
    closeFeeBudget: 700_000n,
    stage: { kind: "open" },
  };
}

/** cbor.serialise(fixtures.datum(Open)) in Aiken. */
export const GOLDEN_OPEN_CBOR =
  "d8799f58200000000000000000000000000000000000000000000000000000000000000001582079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664d8799fd8799f581cb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1ffd8799fd8799fd8799f581cb5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5ffffffffd8799fd8799f581c5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5effd87a80ff581ce675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9490014df10745553444d194e2018645820ababababababababababababababababababababababababababababababababd8799fd8799f581cfefefefefefefefefefefefefefefefefefefefefefefefefefefefeffd87a80ff19012c581cc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c11a0036ee801a000aae60d87980ff";

/** cbor.serialise(fixtures.datum(Closing { accepted: 62, contest_end: 1_791_234_567_890 })) in Aiken. */
export const GOLDEN_CLOSING_CBOR =
  "d8799f58200000000000000000000000000000000000000000000000000000000000000001582079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664d8799fd8799f581cb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1ffd8799fd8799fd8799f581cb5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5ffffffffd8799fd8799f581c5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5effd87a80ff581ce675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9490014df10745553444d194e2018645820ababababababababababababababababababababababababababababababababd8799fd8799f581cfefefefefefefefefefefefefefefefefefefefefefefefefefefefeffd87a80ff19012c581cc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c11a0036ee801a000aae60d87a9f183e1b000001a10de66ed2ffff";
