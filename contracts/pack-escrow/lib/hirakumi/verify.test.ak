//// Independent verifier: attacks on the fixed Close window (L9), the Settle
//// fee rule (L8) and the foreign-asset return (L10). Each test states the
//// SAFE expectation (a `fail` test must be rejected by the validator), plus
//// liveness checks that the new rules never make an honest exit impossible.

use aiken/interval.{after, before, between}
use cardano/address.{from_verification_key}
use cardano/assets
use cardano/transaction.{InlineDatum, Input, NoDatum, Output, OutputReference}
use hirakumi/escrow.{validate}
use hirakumi/fixtures.{
  buyer, buyer_vkh, channel, close_hi, contest_end, continuing, datum,
  fee_address, lock_input, lock_input_with, locked_lovelace, locked_tokens,
  operator_input, own_ref, seller, tagged, third_vkh, tx, usdm,
}
use hirakumi/types.{Close, Closing, Open, PackDatum, Settle}

const junk: ByteArray =
  #"0101010101010101010101010101010101010101010101010101010101"

fn closing(accepted: Int) -> PackDatum {
  datum(Closing { accepted, contest_end })
}

fn third_input() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      output_index: 0,
    },
    output: Output {
      address: from_verification_key(third_vkh),
      value: assets.from_lovelace(50_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn tagged_value(to, value) -> Output {
  let tag: Data = channel
  Output { address: to, value, datum: InlineDatum(tag), reference_script: None }
}

fn lock_with_junk(q: Int) {
  usdm(locked_tokens, locked_lovelace) |> assets.add(junk, #"6e6674", q)
}

fn settle_junk(outputs: List<Output>, signers: List<ByteArray>, fee: Int) -> Bool {
  let d = closing(62)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input_with(d, lock_with_junk(5)), third_input()],
      outputs,
      after(contest_end + 1),
      signers,
      fee,
    ),
  )
}

// ---------------------------------------------------------------- Close window

test verify_close_negative_infinity_lower_bound_rejected() fail {
  let d = datum(Open)
  validate(
    d,
    Close { accepted: 0, signature: #"" },
    own_ref,
    tx(
      [lock_input(d), operator_input()],
      [
        continuing(
          PackDatum { ..d, stage: Closing { accepted: 0, contest_end } },
        ),
      ],
      before(close_hi),
      [buyer_vkh],
      300_000,
    ),
  )
}

test verify_close_window_cap_still_lets_the_buyer_exit() {
  // A one-second window (what a wallet would build) works for the buyer.
  let d = datum(Open)
  validate(
    d,
    Close { accepted: 0, signature: #"" },
    own_ref,
    tx(
      [lock_input(d)],
      [
        continuing(
          PackDatum {
            ..d,
            stage: Closing { accepted: 0, contest_end: close_hi + 3_600_000 },
          },
        ),
      ],
      between(close_hi - 1_000, close_hi),
      [buyer_vkh],
      300_000,
    ),
  )
}

// ---------------------------------------------------------------- Settle fee (L8)

test verify_settle_buyer_signed_fee_within_budget() {
  let d = closing(62)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input(d), third_input()],
      [
        tagged(seller(), 1_202_800, 1_200_000),
        tagged(fee_address(), 37_200, 1_200_000),
        tagged(buyer(), 760_000, locked_lovelace - 700_000),
      ],
      after(contest_end + 1),
      [buyer_vkh],
      700_000,
    ),
  )
}

test verify_settle_buyer_signed_fee_over_budget_rejected() fail {
  let d = closing(62)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input(d), third_input()],
      [
        tagged(seller(), 1_202_800, 1_200_000),
        tagged(fee_address(), 37_200, 1_200_000),
        tagged(buyer(), 760_000, locked_lovelace - 700_001),
      ],
      after(contest_end + 1),
      [buyer_vkh],
      700_001,
    ),
  )
}

test verify_settle_unrelated_signer_is_not_charged_even_with_big_fee() {
  // Liveness: anyone may settle at their own cost, whatever the fee.
  let d = closing(62)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input(d), third_input()],
      [
        tagged(seller(), 1_202_800, 1_200_000),
        tagged(fee_address(), 37_200, 1_200_000),
        tagged(buyer(), 760_000, locked_lovelace),
      ],
      after(contest_end + 1),
      [third_vkh],
      5_000_000,
    ),
  )
}

test verify_settle_unrelated_signer_cannot_take_any_fee() fail {
  let d = closing(62)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input(d), third_input()],
      [
        tagged(seller(), 1_202_800, 1_200_000),
        tagged(fee_address(), 37_200, 1_200_000),
        tagged(buyer(), 760_000, locked_lovelace - 1),
      ],
      after(contest_end + 1),
      [third_vkh],
      200_000,
    ),
  )
}

// ---------------------------------------------------------------- foreign assets (L10)

test verify_foreign_split_across_two_tagged_buyer_outputs_ok() {
  settle_junk(
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged_value(
        buyer(),
        usdm(760_000, locked_lovelace) |> assets.add(junk, #"6e6674", 2),
      ),
      tagged_value(
        buyer(),
        assets.from_lovelace(1_200_000) |> assets.add(junk, #"6e6674", 3),
      ),
    ],
    [],
    300_000,
  )
}

test verify_foreign_partially_returned_rejected() fail {
  settle_junk(
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged_value(
        buyer(),
        usdm(760_000, locked_lovelace) |> assets.add(junk, #"6e6674", 4),
      ),
      Output {
        address: from_verification_key(third_vkh),
        value: assets.from_lovelace(1_200_000) |> assets.add(junk, #"6e6674", 1),
        datum: NoDatum,
        reference_script: None,
      },
    ],
    [],
    300_000,
  )
}

test verify_foreign_to_untagged_buyer_output_rejected() fail {
  // Untagged outputs to the buyer don't count (another escrow could claim them).
  settle_junk(
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 760_000, locked_lovelace),
      Output {
        address: buyer(),
        value: assets.from_lovelace(1_200_000) |> assets.add(junk, #"6e6674", 5),
        datum: NoDatum,
        reference_script: None,
      },
    ],
    [],
    300_000,
  )
}

test verify_foreign_to_seller_rejected() fail {
  settle_junk(
    [
      tagged_value(
        seller(),
        usdm(1_202_800, 1_200_000) |> assets.add(junk, #"6e6674", 5),
      ),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 760_000, locked_lovelace),
    ],
    [],
    300_000,
  )
}

test verify_foreign_with_closer_charged_settle_ok() {
  // Liveness: the charged (closer-signed) Settle also works with foreign assets.
  settle_junk(
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged_value(
        buyer(),
        usdm(760_000, locked_lovelace - 400_000)
          |> assets.add(junk, #"6e6674", 5),
      ),
    ],
    [fixtures.closer_vkh],
    400_000,
  )
}
