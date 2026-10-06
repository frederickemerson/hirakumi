//// Adversarial review of the pack escrow. Each test states the SAFE
//// expectation. Tests prefixed `stuck_` / `by_design_` / `unproven_` document
//// behaviour the contract accepts (or that depends on the evaluator); the
//// former `vuln_` findings (L8, L10) and the Close-window findings (L9, L12)
//// are fixed and now assert the safe behaviour.

use aiken/interval.{after, between}
use aiken/primitive/bytearray
use cardano/address.{from_script, from_verification_key, with_delegation_key}
use cardano/assets
use cardano/transaction.{
  DatumHash, InlineDatum, Input, NoDatum, Output, OutputReference,
}
use hirakumi/escrow.{validate}
use hirakumi/fixtures.{
  buyer, buyer_stake_vkh, buyer_vkh, channel, close_hi, close_lo, closer_vkh,
  contest_end, continuing, datum, fee_address, golden_pk, lock_input,
  lock_input_with, locked_lovelace, locked_tokens, operator_input, other_channel,
  own_ref, script_address, script_output, seller, sig_62, sig_7, tagged,
  third_vkh, tx, usdm,
}
use hirakumi/iou.{iou_message, iou_valid, prefix}
use hirakumi/types.{Close, Closing, Open, PackDatum, Raise, Settle}

// ---------------------------------------------------------------------------
// Extra fixtures
// ---------------------------------------------------------------------------

/// Golden key, channel 00..01, count 2^63 (signed with @noble/curves).
const sig_2p63: ByteArray =
  #"2991760c3bfa2e5b4d01a20a70ac2d8faf0ea182f480501d05b341290bbed563a9c4b88aa8a9553bf4e1d77130813885f1e1bc1e94b39e6f85eaa34a9fb39f09"

/// Golden key, channel 00..01, count 2^64 - 1.
const sig_u64max: ByteArray =
  #"354b1be3dd34f110536a59c33951b02fe9fa5d298011dcc2f2335921ba2b5cb0ed0afd785ddae2fd9997d593dc971e0d16a114e4bd5249325c3c40565eb2cf02"

/// Golden key, channel 00..01, count 62, with R' = R + T (T of order 8).
/// Passes a cofactored verifier (@noble/curves, zip215 true AND false) but
/// fails the cofactorless check libsodium / cardano-node apply on-chain.
const sig_62_torsion: ByteArray =
  #"d63c01223147541df4e170763e9e2788a8bf5971f52a93c5829dbe6f5ff6bba9b85a45bd4818016f3852e40a838c99c4fe49d1cd3e0f5523ea00a2d9a56b1d05"

/// Identity point as a "public key" (small order) + R = identity, S = 0.
/// @noble/curves (default zip215) accepts this for EVERY message.
const identity_pk: ByteArray =
  #"0100000000000000000000000000000000000000000000000000000000000000"

const identity_sig: ByteArray =
  #"01000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"

fn closing(accepted: Int) -> PackDatum {
  datum(Closing { accepted, contest_end })
}

fn attacker() {
  from_verification_key(third_vkh)
}

fn attacker_input() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      output_index: 0,
    },
    output: Output {
      address: attacker(),
      value: assets.from_lovelace(50_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

fn plain(to, value) -> Output {
  Output { address: to, value, datum: NoDatum, reference_script: None }
}

fn close_tx(
  d: PackDatum,
  accepted: Int,
  sig: ByteArray,
  outputs: List<Output>,
  lo: Int,
  hi: Int,
  signers: List<ByteArray>,
) -> Bool {
  validate(
    d,
    Close { accepted, signature: sig },
    own_ref,
    tx(
      [lock_input(d), operator_input()],
      outputs,
      between(lo, hi),
      signers,
      300_000,
    ),
  )
}

fn raise_tx(
  d: PackDatum,
  accepted: Int,
  sig: ByteArray,
  outputs: List<Output>,
) -> Bool {
  validate(
    d,
    Raise { accepted, signature: sig },
    own_ref,
    tx([lock_input(d)], outputs, between(4_000_000, 5_000_000), [], 300_000),
  )
}

fn settle_tx(
  d: PackDatum,
  inputs: List<Input>,
  outputs: List<Output>,
  fee: Int,
) -> Bool {
  validate(
    d,
    Settle,
    own_ref,
    tx(inputs, outputs, after(contest_end + 1), [closer_vkh], fee),
  )
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------

test adv_close_third_party_zero_rejected() fail {
  let d = datum(Open)
  close_tx(
    d,
    0,
    #"",
    [continuing(PackDatum { ..d, stage: Closing { accepted: 0, contest_end } })],
    close_lo,
    close_hi,
    [third_vkh],
  )
}

test adv_close_signed_by_buyer_stake_key_rejected() fail {
  // The stake key of the refund address is not the buyer's identity.
  let d = datum(Open)
  close_tx(
    d,
    0,
    #"",
    [continuing(PackDatum { ..d, stage: Closing { accepted: 0, contest_end } })],
    close_lo,
    close_hi,
    [buyer_stake_vkh],
  )
}

test adv_close_replay_on_closing_rejected() fail {
  // Re-closing an already Closing pack to reset contest_end / accepted.
  let d = closing(62)
  close_tx(
    d,
    0,
    #"",
    [continuing(PackDatum { ..d, stage: Closing { accepted: 0, contest_end } })],
    close_lo,
    close_hi,
    [buyer_vkh],
  )
}

test adv_close_continuing_datum_hash_rejected() fail {
  let d = datum(Open)
  let next = PackDatum { ..d, stage: Closing { accepted: 0, contest_end } }
  close_tx(
    d,
    0,
    #"",
    [Output { ..continuing(next), datum: DatumHash(#"00") }],
    close_lo,
    close_hi,
    [closer_vkh],
  )
}

test adv_close_redirect_value_to_attacker_rejected() fail {
  // Closer pays the whole lock to itself and leaves no continuing output.
  let d = datum(Open)
  close_tx(
    d,
    0,
    #"",
    [
      plain(
        from_verification_key(closer_vkh),
        usdm(locked_tokens, locked_lovelace),
      ),
    ],
    close_lo,
    close_hi,
    [closer_vkh],
  )
}

test adv_close_continuing_plus_dust_script_output_rejected() fail {
  let d = datum(Open)
  let next = PackDatum { ..d, stage: Closing { accepted: 0, contest_end } }
  close_tx(
    d,
    0,
    #"",
    [continuing(next), script_output(next, assets.from_lovelace(1_000_000))],
    close_lo,
    close_hi,
    [closer_vkh],
  )
}

test adv_close_with_iou_from_other_channel_rejected() fail {
  // Buyer's IOU for channel 00..01 replayed on a pack with channel 00..02.
  let d = PackDatum { ..datum(Open), channel_id: other_channel }
  close_tx(
    d,
    62,
    sig_62,
    [
      continuing(
        PackDatum { ..d, stage: Closing { accepted: 62, contest_end } },
      ),
    ],
    close_lo,
    close_hi,
    [closer_vkh],
  )
}

/// L9 (fixed): contest_end is upper + contest_period, so a Close's validity
/// range is capped at max_close_window (1 h). A year-long window is rejected.
test adv_close_far_future_upper_bound_rejected() fail {
  let d = datum(Open)
  let year = 31_536_000_000
  let ce = close_hi + year + d.contest_period
  close_tx(
    d,
    0,
    #"",
    [
      continuing(
        PackDatum { ..d, stage: Closing { accepted: 0, contest_end: ce } },
      ),
    ],
    close_lo,
    close_hi + year,
    [closer_vkh],
  )
}

/// L12 (fixed): a negative contest_period would put contest_end in the past,
/// making Raise impossible and Settle immediate. The validator clamps the
/// period to min_contest_period (60 s), so this Close is rejected.
test adv_negative_contest_period_cannot_skip_contest() fail {
  let d = PackDatum { ..datum(Open), contest_period: -1_000_000 }
  let next = PackDatum {
    ..d,
    stage: Closing { accepted: 0, contest_end: close_hi - 1_000_000 },
  }
  and {
    close_tx(d, 0, #"", [continuing(next)], close_lo, close_hi, [buyer_vkh]),
    validate(
      next,
      Settle,
      own_ref,
      tx(
        [lock_input(next)],
        [tagged(buyer(), locked_tokens, 1_600_000)],
        after(close_hi),
        [],
        400_000,
      ),
    ),
  }
}

/// L12: the same datum still closes, with the contest window clamped to 60 s.
test adv_negative_contest_period_clamped_to_minimum() {
  let d = PackDatum { ..datum(Open), contest_period: -1_000_000 }
  let next = PackDatum {
    ..d,
    stage: Closing { accepted: 0, contest_end: close_hi + 60_000 },
  }
  close_tx(d, 0, #"", [continuing(next)], close_lo, close_hi, [buyer_vkh])
}

// ---------------------------------------------------------------------------
// Raise
// ---------------------------------------------------------------------------

test adv_raise_other_channel_iou_rejected() fail {
  let d = PackDatum { ..closing(7), channel_id: other_channel }
  raise_tx(
    d,
    62,
    sig_62,
    [
      continuing(
        PackDatum { ..d, stage: Closing { accepted: 62, contest_end } },
      ),
    ],
  )
}

test adv_raise_negative_count_rejected() fail {
  raise_tx(closing(0), -1, #"", [continuing(closing(-1))])
}

test adv_raise_continuing_datum_hash_rejected() fail {
  raise_tx(
    closing(7),
    62,
    sig_62,
    [Output { ..continuing(closing(62)), datum: DatumHash(#"00") }],
  )
}

test adv_raise_continuing_plus_dust_script_output_rejected() fail {
  raise_tx(
    closing(7),
    62,
    sig_62,
    [
      continuing(closing(62)),
      script_output(closing(62), assets.from_lovelace(1_000_000)),
    ],
  )
}

test adv_raise_skim_lovelace_rejected() fail {
  raise_tx(
    closing(7),
    62,
    sig_62,
    [
      script_output(closing(62), usdm(locked_tokens, locked_lovelace - 1)),
      plain(attacker(), assets.from_lovelace(1)),
    ],
  )
}

test adv_raise_continuing_with_reference_script_rejected() fail {
  raise_tx(
    closing(7),
    62,
    sig_62,
    [Output { ..continuing(closing(62)), reference_script: Some(#"00") }],
  )
}

test adv_raise_count_2p64_rejected() fail {
  // u64 overflow: 2^64 must not wrap to 0 in the IOU message.
  let d = PackDatum {
    ..closing(7),
    price_per_call: 0,
    max_calls: 100_000_000_000_000_000_000,
  }
  let n = 18_446_744_073_709_551_616
  raise_tx(
    d,
    n,
    sig_7,
    [continuing(PackDatum { ..d, stage: Closing { accepted: n, contest_end } })],
  )
}

test adv_raise_count_u64max_accepted_when_datum_allows() {
  // Upper edge of the encoding works (needs price 0, a nonsense datum).
  let d = PackDatum {
    ..closing(7),
    price_per_call: 0,
    max_calls: 18_446_744_073_709_551_615,
  }
  let n = 18_446_744_073_709_551_615
  raise_tx(
    d,
    n,
    sig_u64max,
    [continuing(PackDatum { ..d, stage: Closing { accepted: n, contest_end } })],
  )
}

test adv_iou_message_2p63_is_unsigned_big_endian() {
  // 2^63 has the top bit set: must encode as unsigned 0x80.., not fail/sign-wrap.
  let n = 9_223_372_036_854_775_808
  and {
    iou_message(channel, n) == (
      prefix
        |> bytearray.concat(channel)
        |> bytearray.concat(#"8000000000000000")
    ),
    iou_valid(golden_pk, channel, n, sig_2p63),
    !iou_valid(golden_pk, channel, 0, sig_2p63),
  }
}

test adv_raise_torsion_mauled_signature_rejected() fail {
  // Cardano verifies cofactorless (libsodium): R' = R + T must not verify.
  raise_tx(closing(7), 62, sig_62_torsion, [continuing(closing(62))])
}

/// UNPROVEN / evaluator-dependent: Aiken's local VM (cryptoxide) ACCEPTS this
/// identity-key forgery for any count. cardano-node verifies with libsodium,
/// which rejects small-order public keys and R. Either way the receipt key
/// must be rejected off-chain at quote time (see report).
test unproven_small_order_receipt_key_accepted_by_aiken_vm() {
  let d = PackDatum { ..closing(7), receipt_key: identity_pk }
  raise_tx(
    d,
    62,
    identity_sig,
    [
      continuing(
        PackDatum { ..d, stage: Closing { accepted: 62, contest_end } },
      ),
    ],
  )
}

// ---------------------------------------------------------------------------
// Settle
//   62 × 20_000 = 1_240_000 gross; fee 37_200; seller 1_202_800; buyer 760_000.
// ---------------------------------------------------------------------------

test adv_settle_seller_same_payment_key_other_stake_cannot_absorb_buyer() fail {
  // seller = buyer's payment key on an enterprise address (no stake part).
  // Attacker pays everything to the seller address, nothing to buyer's base address.
  let seller_ent = from_verification_key(buyer_vkh)
  let d = PackDatum { ..closing(62), seller: seller_ent }
  settle_tx(
    d,
    [lock_input(d), operator_input()],
    [
      tagged(seller_ent, 1_962_800, 3_600_000),
      tagged(fee_address(), 37_200, 1_200_000),
    ],
    400_000,
  )
}

test adv_settle_seller_same_payment_key_other_stake_pays_both() {
  let seller_ent = from_verification_key(buyer_vkh)
  let d = PackDatum { ..closing(62), seller: seller_ent }
  settle_tx(
    d,
    [lock_input(d), operator_input()],
    [
      tagged(seller_ent, 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
  )
}

test adv_settle_buyer_equals_fee_address_underpaid_rejected() fail {
  // Partial overlap: fee_address == buyer_refund. One buyer output covering
  // only the buyer share (not buyer + fee) must not satisfy both.
  let d = PackDatum { ..closing(62), fee_address: buyer() }
  settle_tx(
    d,
    [lock_input(d), operator_input()],
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
  )
}

test adv_settle_buyer_equals_fee_address_summed_ok() {
  let d = PackDatum { ..closing(62), fee_address: buyer() }
  settle_tx(
    d,
    [lock_input(d), operator_input()],
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(buyer(), 797_200, 1_600_000),
    ],
    400_000,
  )
}

test adv_settle_tag_as_datum_hash_rejected() fail {
  let o = tagged(buyer(), 760_000, 1_600_000)
  settle_tx(
    closing(62),
    [lock_input(closing(62)), operator_input()],
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      Output { ..o, datum: DatumHash(channel) },
    ],
    400_000,
  )
}

test adv_settle_tokens_under_other_asset_name_rejected() fail {
  // Paying the buyer in a worthless token of the same policy.
  let fake = assets.from_lovelace(1_600_000)
    |> assets.add(
        #"e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9",
        #"6a756e6b",
        760_000,
      )
  let tag: Data = channel
  settle_tx(
    closing(62),
    [lock_input(closing(62)), operator_input()],
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      Output {
        address: buyer(),
        value: fake,
        datum: InlineDatum(tag),
        reference_script: None,
      },
    ],
    400_000,
  )
}

test adv_settle_locked_lovelace_below_fee_still_settles() {
  // Lock holds less lovelace than the fee: buyer is owed tokens only.
  let d = closing(0)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input_with(d, usdm(locked_tokens, 100_000)), attacker_input()],
      [tagged(buyer(), locked_tokens, 1_200_000)],
      after(contest_end + 1),
      [],
      400_000,
    ),
  )
}

test adv_settle_min_rounding_fee_never_negative() {
  // 1 call at price 1, 10% fee: gross 1, fee floor(0.1) = 0, seller 1.
  let d = PackDatum { ..closing(1), price_per_call: 1, fee_bps: 1000 }
  settle_tx(
    d,
    [lock_input(d), operator_input()],
    [tagged(seller(), 1, 1_200_000), tagged(buyer(), 1_999_999, 1_600_000)],
    400_000,
  )
}

/// L10 (fixed): a non-pack asset sitting in the lock goes back to the buyer;
/// a permissionless settler can't keep it. (Unsigned, so the buyer is owed
/// all the locked lovelace and that is paid: only the asset is withheld.)
test adv_settle_foreign_asset_cannot_be_taken_by_settler() fail {
  let d = closing(62)
  let junk_policy = #"0101010101010101010101010101010101010101010101010101010101"
  let lock = usdm(locked_tokens, locked_lovelace)
    |> assets.add(junk_policy, #"6e6674", 1)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input_with(d, lock), attacker_input()],
      [
        tagged(seller(), 1_202_800, 1_200_000),
        tagged(fee_address(), 37_200, 1_200_000),
        tagged(buyer(), 760_000, locked_lovelace),
        plain(
          attacker(),
          assets.from_lovelace(1_500_000)
            |> assets.add(junk_policy, #"6e6674", 1),
        ),
      ],
      after(contest_end + 1),
      [],
      400_000,
    ),
  )
}

/// L10 control: the same unsigned Settle passes once the foreign asset goes
/// to the buyer in a tagged output.
test adv_settle_foreign_asset_returned_to_buyer_by_unsigned_settler() {
  let d = closing(62)
  let junk_policy = #"0101010101010101010101010101010101010101010101010101010101"
  let lock = usdm(locked_tokens, locked_lovelace)
    |> assets.add(junk_policy, #"6e6674", 1)
  let tag: Data = channel
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input_with(d, lock), attacker_input()],
      [
        tagged(seller(), 1_202_800, 1_200_000),
        tagged(fee_address(), 37_200, 1_200_000),
        Output {
          address: buyer(),
          value: usdm(760_000, locked_lovelace)
            |> assets.add(junk_policy, #"6e6674", 1),
          datum: InlineDatum(tag),
          reference_script: None,
        },
      ],
      after(contest_end + 1),
      [],
      400_000,
    ),
  )
}

/// L8 (fixed): the buyer pays tx.fee only when the closer or the buyer signs.
/// An unsigned third-party settler can no longer have the buyer's locked
/// lovelace pay for its own unrelated outputs.
test adv_settle_unsigned_settler_cannot_charge_buyer_fee() fail {
  let d = closing(62)
  let budget = d.close_fee_budget
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input(d), attacker_input()],
      [
        tagged(seller(), 1_202_800, 1_200_000),
        tagged(fee_address(), 37_200, 1_200_000),
        // buyer gets locked − 700_000 = 1_300_000 lovelace
        tagged(buyer(), 760_000, locked_lovelace - budget),
        // attacker's own unrelated outputs ride along on the buyer-paid fee
        plain(attacker(), assets.from_lovelace(10_000_000)),
        plain(attacker(), assets.from_lovelace(10_000_000)),
        plain(attacker(), assets.from_lovelace(10_000_000)),
      ],
      after(contest_end + 1),
      [],
      budget,
    ),
  )
}

/// UNPROVEN double satisfaction: the guard only counts inputs at THIS
/// payment credential. A pack at a different escrow hash (e.g. a redeploy)
/// with the same channel_id and parties could share these outputs.
test by_design_settle_ignores_inputs_of_other_scripts() {
  let d = closing(62)
  let other_script_lock = Input {
    output_reference: OutputReference {
      transaction_id: #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      output_index: 0,
    },
    output: Output {
      ..script_output(d, usdm(locked_tokens, locked_lovelace)),
      address: from_script(
        #"5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d",
      ),
    },
  }
  settle_tx(
    d,
    [lock_input(d), other_script_lock],
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
  )
}

test adv_settle_same_script_other_stake_input_rejected() fail {
  // Second pack at the same script but a different stake part still counts.
  let d = closing(62)
  let twin = Input {
    output_reference: OutputReference {
      transaction_id: #"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      output_index: 0,
    },
    output: Output {
      ..script_output(d, usdm(locked_tokens, locked_lovelace)),
      address: script_address() |> with_delegation_key(third_vkh),
    },
  }
  settle_tx(
    d,
    [lock_input(d), twin],
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
  )
}

/// Guarded off-chain only (closeFeeBudget ≥ 500_000): with a budget below
/// any real Plutus tx fee, no Settle can ever be built and the pack is stuck.
test stuck_settle_with_tiny_close_fee_budget() fail {
  let d = PackDatum { ..closing(0), close_fee_budget: 100_000 }
  settle_tx(
    d,
    [lock_input(d), attacker_input()],
    [tagged(buyer(), locked_tokens, 1_800_000)],
    200_000,
  )
}

/// L8: with a budget below any real fee, an unsigned settler still gets the
/// pack out: it pays the fee itself and the buyer gets all the lovelace.
test adv_tiny_close_fee_budget_unsigned_settle_works() {
  let d = PackDatum { ..closing(0), close_fee_budget: 100_000 }
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input(d), attacker_input()],
      [tagged(buyer(), locked_tokens, 2_000_000)],
      after(contest_end + 1),
      [],
      200_000,
    ),
  )
}
