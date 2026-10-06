use aiken/interval.{Finite, Interval, IntervalBound, after, before, between}
use cardano/address.{with_delegation_key}
use cardano/assets
use cardano/transaction.{InlineDatum, NoDatum, Output}
use hirakumi/escrow.{split, validate}
use hirakumi/fixtures.{
  buyer, buyer_vkh, close_hi, close_lo, closer_vkh, contest_end, continuing,
  datum, fee_address, lock_input, lock_input_with, locked_lovelace,
  locked_tokens, operator_input, other_channel, other_lock_input, own_ref,
  script_address, script_output, seller, sig_100, sig_62, sig_7, sig_8, tagged,
  third_vkh, tx, usdm,
}
use hirakumi/types.{Close, Closing, Open, PackDatum, Raise, Settle}

// ---------------------------------------------------------------------------
// Close  (Open -> Closing)
// ---------------------------------------------------------------------------

fn closing_after_close(d: PackDatum, accepted: Int) -> PackDatum {
  PackDatum { ..d, stage: Closing { accepted, contest_end } }
}

fn close_with(
  d: PackDatum,
  accepted: Int,
  signature: ByteArray,
  signers: List<ByteArray>,
) -> Bool {
  validate(
    d,
    Close { accepted, signature },
    own_ref,
    tx(
      [lock_input(d), operator_input()],
      [continuing(closing_after_close(d, accepted))],
      between(close_lo, close_hi),
      signers,
      300_000,
    ),
  )
}

test close_by_buyer_with_zero_needs_no_signature() {
  close_with(datum(Open), 0, #"", [buyer_vkh])
}

test close_by_closer_with_zero_needs_no_signature() {
  close_with(datum(Open), 0, #"", [closer_vkh])
}

test close_by_closer_with_valid_iou() {
  close_with(datum(Open), 7, sig_7, [closer_vkh])
}

test close_by_buyer_with_valid_iou() {
  close_with(datum(Open), 62, sig_62, [buyer_vkh])
}

test close_with_all_calls_accepted() {
  close_with(datum(Open), 100, sig_100, [closer_vkh])
}

test close_zero_works_even_with_nonsense_max_calls() {
  // Exit must never depend on datum sanity.
  close_with(PackDatum { ..datum(Open), max_calls: -5 }, 0, #"", [buyer_vkh])
}

test close_rejects_third_party() fail {
  close_with(datum(Open), 7, sig_7, [third_vkh])
}

test close_rejects_no_signer() fail {
  close_with(datum(Open), 0, #"", [])
}

test close_rejects_bad_signature() fail {
  close_with(datum(Open), 7, sig_8, [closer_vkh])
}

test close_rejects_corrupted_signature() fail {
  let bad = #"cad601bc32747bf1e603e1b2cdd0a3bbb487b790b7e89c270ec6991f04ca7f0a3ee744595dff9ae7a395a4028bc061f8ae6d7c86c7ba5d10d7844e1088c1ba09"
  close_with(datum(Open), 7, bad, [closer_vkh])
}

test close_rejects_signature_for_other_channel() fail {
  close_with(
    PackDatum { ..datum(Open), channel_id: other_channel },
    7,
    sig_7,
    [closer_vkh],
  )
}

test close_rejects_signature_for_other_count() fail {
  close_with(datum(Open), 8, sig_7, [closer_vkh])
}

test close_rejects_accepted_above_max() fail {
  close_with(PackDatum { ..datum(Open), max_calls: 6 }, 7, sig_7, [closer_vkh])
}

test close_rejects_accepted_times_price_above_locked() fail {
  // 100 × 20_001 > 2_000_000 locked
  close_with(
    PackDatum { ..datum(Open), price_per_call: 20_001 },
    100,
    sig_100,
    [closer_vkh],
  )
}

test close_rejects_negative_accepted() fail {
  close_with(datum(Open), -1, #"", [buyer_vkh])
}

test close_rejects_when_already_closing() fail {
  let d = datum(Closing { accepted: 0, contest_end })
  close_with(d, 7, sig_7, [closer_vkh])
}

fn close_outputs(outputs: List<Output>) -> Bool {
  let d = datum(Open)
  validate(
    d,
    Close { accepted: 7, signature: sig_7 },
    own_ref,
    tx(
      [lock_input(d), operator_input()],
      outputs,
      between(close_lo, close_hi),
      [closer_vkh],
      300_000,
    ),
  )
}

test close_accepts_more_lovelace_on_continuing_output() {
  let d = closing_after_close(datum(Open), 7)
  close_outputs([script_output(d, usdm(locked_tokens, locked_lovelace + 1))])
}

test close_rejects_missing_continuing_output() fail {
  close_outputs([tagged(buyer(), locked_tokens, locked_lovelace)])
}

test close_rejects_fewer_tokens_on_continuing_output() fail {
  let d = closing_after_close(datum(Open), 7)
  close_outputs([script_output(d, usdm(locked_tokens - 1, locked_lovelace))])
}

test close_rejects_less_lovelace_on_continuing_output() fail {
  let d = closing_after_close(datum(Open), 7)
  close_outputs([script_output(d, usdm(locked_tokens, locked_lovelace - 1))])
}

test close_rejects_extra_assets_on_continuing_output() fail {
  let d = closing_after_close(datum(Open), 7)
  close_outputs(
    [
      script_output(
        d,
        usdm(locked_tokens, locked_lovelace)
          |> assets.add(#"0101", #"6a756e6b", 1),
      ),
    ],
  )
}

test close_rejects_two_continuing_outputs() fail {
  let d = closing_after_close(datum(Open), 7)
  close_outputs([continuing(d), continuing(d)])
}

test close_rejects_continuing_output_with_reference_script() fail {
  let d = closing_after_close(datum(Open), 7)
  close_outputs(
    [Output { ..continuing(d), reference_script: Some(#"0102030405") }],
  )
}

test close_rejects_continuing_output_at_other_stake_part() fail {
  let d = closing_after_close(datum(Open), 7)
  let o = continuing(d)
  close_outputs(
    [
      Output {
        ..o,
        address: script_address()
          |> with_delegation_key(third_vkh),
      },
    ],
  )
}

test close_rejects_wrong_contest_end() fail {
  let d = PackDatum {
    ..datum(Open),
    stage: Closing { accepted: 7, contest_end: contest_end + 1 },
  }
  close_outputs([continuing(d)])
}

test close_rejects_wrong_accepted_in_new_datum() fail {
  close_outputs([continuing(closing_after_close(datum(Open), 8))])
}

test close_rejects_changed_field_in_new_datum() fail {
  let d = closing_after_close(PackDatum { ..datum(Open), seller: buyer() }, 7)
  close_outputs([continuing(d)])
}

test close_rejects_continuing_output_without_inline_datum() fail {
  let d = closing_after_close(datum(Open), 7)
  close_outputs([Output { ..continuing(d), datum: NoDatum }])
}

test close_rejects_second_script_input() fail {
  let d = datum(Open)
  validate(
    d,
    Close { accepted: 0, signature: #"" },
    own_ref,
    tx(
      [lock_input(d), other_lock_input(d), operator_input()],
      [continuing(closing_after_close(d, 0))],
      between(close_lo, close_hi),
      [buyer_vkh],
      300_000,
    ),
  )
}

test close_rejects_open_ended_validity_range() fail {
  let d = datum(Open)
  validate(
    d,
    Close { accepted: 0, signature: #"" },
    own_ref,
    tx(
      [lock_input(d), operator_input()],
      [continuing(closing_after_close(d, 0))],
      after(close_lo),
      [buyer_vkh],
      300_000,
    ),
  )
}

test close_uses_exclusive_upper_bound_value_as_is() {
  // The ledger hands V3 scripts an exclusive upper bound.
  let d = datum(Open)
  let range = Interval {
    lower_bound: IntervalBound {
      bound_type: Finite(close_lo),
      is_inclusive: True,
    },
    upper_bound: IntervalBound {
      bound_type: Finite(close_hi),
      is_inclusive: False,
    },
  }
  validate(
    d,
    Close { accepted: 0, signature: #"" },
    own_ref,
    tx(
      [lock_input(d), operator_input()],
      [continuing(closing_after_close(d, 0))],
      range,
      [buyer_vkh],
      300_000,
    ),
  )
}

// ---------------------------------------------------------------------------
// Raise  (Closing -> Closing, higher count, same contest_end)
// ---------------------------------------------------------------------------

fn raise_with(
  from: Int,
  to: Int,
  signature: ByteArray,
  out: PackDatum,
  lo: Int,
  hi: Int,
) -> Bool {
  let d = datum(Closing { accepted: from, contest_end })
  validate(
    d,
    Raise { accepted: to, signature },
    own_ref,
    tx(
      [lock_input(d), operator_input()],
      [continuing(out)],
      between(lo, hi),
      [],
      300_000,
    ),
  )
}

fn raised(accepted: Int) -> PackDatum {
  datum(Closing { accepted, contest_end })
}

test raise_accepts_higher_iou_without_any_signer() {
  raise_with(7, 62, sig_62, raised(62), 4_000_000, 5_000_000)
}

test raise_from_zero() {
  raise_with(0, 7, sig_7, raised(7), 4_000_000, 5_000_000)
}

test raise_rejects_equal() fail {
  raise_with(62, 62, sig_62, raised(62), 4_000_000, 5_000_000)
}

test raise_rejects_lower() fail {
  raise_with(62, 7, sig_7, raised(7), 4_000_000, 5_000_000)
}

test raise_rejects_bad_signature() fail {
  raise_with(7, 62, sig_100, raised(62), 4_000_000, 5_000_000)
}

test raise_rejects_above_max() fail {
  let d = PackDatum {
    ..datum(Closing { accepted: 7, contest_end }),
    max_calls: 61,
  }
  validate(
    d,
    Raise { accepted: 62, signature: sig_62 },
    own_ref,
    tx(
      [lock_input(d)],
      [
        continuing(
          PackDatum { ..d, stage: Closing { accepted: 62, contest_end } },
        ),
      ],
      between(4_000_000, 5_000_000),
      [],
      300_000,
    ),
  )
}

test raise_rejects_reaching_contest_end_inclusive() fail {
  raise_with(7, 62, sig_62, raised(62), 4_000_000, contest_end)
}

test raise_rejects_after_contest_end() fail {
  raise_with(7, 62, sig_62, raised(62), contest_end + 1, contest_end + 10)
}

test raise_rejects_open_ended_validity_range() fail {
  let d = raised(7)
  validate(
    d,
    Raise { accepted: 62, signature: sig_62 },
    own_ref,
    tx([lock_input(d)], [continuing(raised(62))], after(4_000_000), [], 300_000),
  )
}

test raise_rejects_extended_contest_end() fail {
  let out = datum(Closing { accepted: 62, contest_end: contest_end + 1 })
  raise_with(7, 62, sig_62, out, 4_000_000, 5_000_000)
}

test raise_rejects_shortened_contest_end() fail {
  let out = datum(Closing { accepted: 62, contest_end: contest_end - 1 })
  raise_with(7, 62, sig_62, out, 4_000_000, 5_000_000)
}

test raise_rejects_changed_other_field() fail {
  let out = PackDatum { ..raised(62), fee_bps: 1000 }
  raise_with(7, 62, sig_62, out, 4_000_000, 5_000_000)
}

test raise_rejects_changed_seller() fail {
  let out = PackDatum { ..raised(62), seller: fee_address() }
  raise_with(7, 62, sig_62, out, 4_000_000, 5_000_000)
}

test raise_rejects_new_accepted_mismatch() fail {
  raise_with(7, 62, sig_62, raised(100), 4_000_000, 5_000_000)
}

test raise_rejects_on_open() fail {
  let d = datum(Open)
  validate(
    d,
    Raise { accepted: 62, signature: sig_62 },
    own_ref,
    tx(
      [lock_input(d)],
      [continuing(raised(62))],
      between(4_000_000, 5_000_000),
      [],
      300_000,
    ),
  )
}

test raise_rejects_taking_value() fail {
  let d = raised(7)
  validate(
    d,
    Raise { accepted: 62, signature: sig_62 },
    own_ref,
    tx(
      [lock_input(d)],
      [script_output(raised(62), usdm(locked_tokens - 1, locked_lovelace))],
      between(4_000_000, 5_000_000),
      [],
      300_000,
    ),
  )
}

test raise_rejects_second_script_input() fail {
  let d = raised(7)
  validate(
    d,
    Raise { accepted: 62, signature: sig_62 },
    own_ref,
    tx(
      [lock_input(d), other_lock_input(d)],
      [continuing(raised(62))],
      between(4_000_000, 5_000_000),
      [],
      300_000,
    ),
  )
}

// ---------------------------------------------------------------------------
// Settle  (Closing -> paid out)
//   62 accepted × 20_000 = 1_240_000 gross; 3% = 37_200; seller 1_202_800;
//   buyer 2_000_000 − 1_240_000 = 760_000 tokens and 2_000_000 − fee lovelace.
// ---------------------------------------------------------------------------

fn settle(d: PackDatum, outputs: List<Output>, fee: Int, lo: Int) -> Bool {
  validate(
    d,
    Settle,
    own_ref,
    tx([lock_input(d), operator_input()], outputs, after(lo), [], fee),
  )
}

fn split_outputs() -> List<Output> {
  [
    tagged(seller(), 1_202_800, 1_200_000),
    tagged(fee_address(), 37_200, 1_200_000),
    tagged(buyer(), 760_000, 1_600_000),
  ]
}

test settle_pays_the_split() {
  settle(raised(62), split_outputs(), 400_000, contest_end + 1)
}

test settle_needs_no_signer_and_ignores_output_order() {
  settle(
    raised(62),
    [
      tagged(buyer(), 760_000, 1_600_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(seller(), 1_202_800, 1_200_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_rejects_at_contest_end() fail {
  settle(raised(62), split_outputs(), 400_000, contest_end)
}

test settle_rejects_before_contest_end() fail {
  settle(raised(62), split_outputs(), 400_000, contest_end - 1_000)
}

test settle_rejects_open_lower_bound() fail {
  let d = raised(62)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input(d)],
      split_outputs(),
      before(contest_end + 1_000_000),
      [],
      400_000,
    ),
  )
}

test settle_rejects_on_open() fail {
  settle(datum(Open), split_outputs(), 400_000, contest_end + 1)
}

test settle_rejects_fee_over_budget() fail {
  settle(
    raised(62),
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 760_000, 1_299_999),
    ],
    700_001,
    contest_end + 1,
  )
}

test settle_accepts_fee_equal_to_budget() {
  settle(
    raised(62),
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 760_000, 1_300_000),
    ],
    700_000,
    contest_end + 1,
  )
}

test settle_rejects_buyer_lovelace_below_locked_minus_fee() fail {
  settle(
    raised(62),
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 760_000, 1_599_999),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_rejects_buyer_tokens_short() fail {
  settle(
    raised(62),
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 759_999, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_rejects_seller_short() fail {
  settle(
    raised(62),
    [
      tagged(seller(), 1_202_799, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_rejects_fee_short() fail {
  settle(
    raised(62),
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_199, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_rejects_missing_tag() fail {
  settle(
    raised(62),
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      Output { ..tagged(buyer(), 760_000, 1_600_000), datum: NoDatum },
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_rejects_wrong_tag() fail {
  let wrong: Data = other_channel
  settle(
    raised(62),
    [
      Output {
        ..tagged(seller(), 1_202_800, 1_200_000),
        datum: InlineDatum(wrong),
      },
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_seller_equals_buyer_with_one_summed_output() {
  let d = PackDatum { ..raised(62), seller: buyer() }
  // seller 1_202_800 + buyer 760_000 = 1_962_800 tokens, one output
  settle(
    d,
    [
      tagged(buyer(), 1_962_800, 1_600_000),
      tagged(fee_address(), 37_200, 1_200_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_seller_equals_buyer_rejects_underpaid_aggregate() fail {
  let d = PackDatum { ..raised(62), seller: buyer() }
  // One output that covers either obligation alone but not their sum.
  settle(
    d,
    [
      tagged(buyer(), 1_962_799, 1_600_000),
      tagged(fee_address(), 37_200, 1_200_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_fee_address_equals_seller() {
  let d = PackDatum { ..raised(62), fee_address: seller() }
  settle(
    d,
    [
      tagged(seller(), 1_240_000, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_fee_address_equals_seller_rejects_underpaid() fail {
  let d = PackDatum { ..raised(62), fee_address: seller() }
  settle(
    d,
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_all_three_addresses_equal() {
  let d = PackDatum { ..raised(62), fee_address: buyer(), seller: buyer() }
  settle(d, [tagged(buyer(), 2_000_000, 1_600_000)], 400_000, contest_end + 1)
}

test settle_sums_two_outputs_to_the_same_address() {
  settle(
    raised(62),
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 380_000, 800_000),
      tagged(buyer(), 380_000, 800_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_does_not_sum_untagged_outputs() fail {
  settle(
    raised(62),
    [
      tagged(seller(), 1_202_800, 1_200_000),
      tagged(fee_address(), 37_200, 1_200_000),
      tagged(buyer(), 380_000, 800_000),
      Output { ..tagged(buyer(), 380_000, 800_000), datum: NoDatum },
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_clamps_fee_bps_above_1000() {
  // 5000 bps clamps to 1000: fee 124_000, seller 1_116_000.
  let d = PackDatum { ..raised(62), fee_bps: 5000 }
  settle(
    d,
    [
      tagged(seller(), 1_116_000, 1_200_000),
      tagged(fee_address(), 124_000, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_clamped_fee_bps_does_not_pay_unclamped_fee() fail {
  // Paying the unclamped 50% leaves the seller short.
  let d = PackDatum { ..raised(62), fee_bps: 5000 }
  settle(
    d,
    [
      tagged(seller(), 620_000, 1_200_000),
      tagged(fee_address(), 620_000, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_clamps_negative_fee_bps_to_zero() {
  let d = PackDatum { ..raised(62), fee_bps: -300 }
  settle(
    d,
    [
      tagged(seller(), 1_240_000, 1_200_000),
      tagged(buyer(), 760_000, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_zero_accepted_pays_everything_to_buyer() {
  settle(
    raised(0),
    [tagged(buyer(), 2_000_000, 1_600_000)],
    400_000,
    contest_end + 1,
  )
}

test settle_zero_accepted_rejects_short_buyer() fail {
  settle(
    raised(0),
    [tagged(buyer(), 1_999_999, 1_600_000)],
    400_000,
    contest_end + 1,
  )
}

test settle_all_accepted_buyer_gets_lovelace_only() {
  // 100 × 20_000 = 2_000_000 gross; fee 60_000; seller 1_940_000.
  settle(
    raised(100),
    [
      tagged(seller(), 1_940_000, 1_200_000),
      tagged(fee_address(), 60_000, 1_200_000),
      tagged(buyer(), 0, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_fee_rounds_down() {
  // 1 × 333 at 300 bps: gross 333, fee floor(9.99) = 9, seller 324.
  let d = PackDatum {
    ..datum(Closing { accepted: 1, contest_end }),
    price_per_call: 333,
  }
  settle(
    d,
    [
      tagged(seller(), 324, 1_200_000),
      tagged(fee_address(), 9, 1_200_000),
      tagged(buyer(), 2_000_000 - 333, 1_600_000),
    ],
    400_000,
    contest_end + 1,
  )
}

test settle_donated_extra_tokens_go_to_buyer() {
  let d = raised(62)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [
        lock_input_with(d, usdm(locked_tokens + 500_000, locked_lovelace)),
        operator_input(),
      ],
      [
        tagged(seller(), 1_202_800, 1_200_000),
        tagged(fee_address(), 37_200, 1_200_000),
        tagged(buyer(), 1_260_000, 1_600_000),
      ],
      after(contest_end + 1),
      [],
      400_000,
    ),
  )
}

test settle_donated_extra_tokens_rejects_seller_taking_them() fail {
  let d = raised(62)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [
        lock_input_with(d, usdm(locked_tokens + 500_000, locked_lovelace)),
        operator_input(),
      ],
      [
        tagged(seller(), 1_702_800, 1_200_000),
        tagged(fee_address(), 37_200, 1_200_000),
        tagged(buyer(), 760_000, 1_600_000),
      ],
      after(contest_end + 1),
      [],
      400_000,
    ),
  )
}

test settle_short_lock_caps_seller_at_locked_tokens() {
  // Only 1_000_000 tokens locked but 62 × 20_000 = 1_240_000 accepted:
  // gross = min(1_240_000, 1_000_000) = 1_000_000; fee 30_000; seller 970_000.
  let d = raised(62)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input_with(d, usdm(1_000_000, locked_lovelace)), operator_input()],
      [
        tagged(seller(), 970_000, 1_200_000),
        tagged(fee_address(), 30_000, 1_200_000),
        tagged(buyer(), 0, 1_600_000),
      ],
      after(contest_end + 1),
      [],
      400_000,
    ),
  )
}

test settle_negative_price_still_settles_everything_to_buyer() {
  // A nonsense datum must not strand funds: gross clamps to 0.
  let d = PackDatum { ..raised(62), price_per_call: -20_000 }
  settle(d, [tagged(buyer(), 2_000_000, 1_600_000)], 400_000, contest_end + 1)
}

test settle_rejects_second_script_input() fail {
  let d = raised(62)
  validate(
    d,
    Settle,
    own_ref,
    tx(
      [lock_input(d), other_lock_input(d)],
      split_outputs(),
      after(contest_end + 1),
      [],
      400_000,
    ),
  )
}

// ---------------------------------------------------------------------------
// split(): the exact arithmetic mirrored by closePayouts() in @hirakumi/escrow
// ---------------------------------------------------------------------------

test split_62_of_100() {
  split(62, 20_000, 300, 2_000_000) == (1_202_800, 37_200, 760_000)
}

test split_rounds_fee_down() {
  split(1, 333, 300, 2_000_000) == (324, 9, 1_999_667)
}

test split_clamps_bps_high() {
  split(62, 20_000, 5000, 2_000_000) == (1_116_000, 124_000, 760_000)
}

test split_clamps_bps_negative() {
  split(62, 20_000, -1, 2_000_000) == (1_240_000, 0, 760_000)
}

test split_caps_gross_at_locked() {
  split(62, 20_000, 300, 1_000_000) == (970_000, 30_000, 0)
}

test split_negative_price_pays_seller_nothing() {
  split(62, -20_000, 300, 2_000_000) == (0, 0, 2_000_000)
}
