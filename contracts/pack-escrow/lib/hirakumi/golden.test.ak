//// Cross-language golden vectors, shared with packages/escrow/test/golden.ts.
//// If one of these changes, the TypeScript side must change in the same commit.

use aiken/builtin
use aiken/cbor
use aiken/interval.{
  Finite, Interval, IntervalBound, after, before, between, everything,
  is_entirely_after, is_entirely_before,
}
use hirakumi/fixtures.{channel, datum, golden_pk, sig_7}
use hirakumi/iou.{iou_message, iou_valid}
use hirakumi/types.{Closing, Open}

// --- IOU ------------------------------------------------------------------

test iou_message_layout() {
  iou_message(channel, 7) == #"484b523100000000000000000000000000000000000000000000000000000000000000010000000000000007"
}

test iou_message_is_44_bytes() {
  builtin.length_of_bytearray(iou_message(channel, 123_456)) == 44
}

test iou_message_rejects_counts_that_do_not_fit_8_bytes() fail {
  builtin.length_of_bytearray(iou_message(channel, 18446744073709551616)) == 44
}

test ts_signed_iou_verifies_with_the_builtin() {
  builtin.verify_ed25519_signature(golden_pk, iou_message(channel, 7), sig_7)
}

test ts_signed_iou_verifies_with_iou_valid() {
  iou_valid(golden_pk, channel, 7, sig_7)
}

test iou_valid_rejects_other_count() {
  !iou_valid(golden_pk, channel, 6, sig_7)
}

// --- Datum CBOR -------------------------------------------------------------
// Buyer = base address (key payment + key stake); seller and fee = enterprise.

const golden_open_cbor: ByteArray =
  #"d8799f58200000000000000000000000000000000000000000000000000000000000000001582079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664d8799fd8799f581cb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1ffd8799fd8799fd8799f581cb5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5ffffffffd8799fd8799f581c5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5effd87a80ff581ce675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9490014df10745553444d194e2018645820ababababababababababababababababababababababababababababababababd8799fd8799f581cfefefefefefefefefefefefefefefefefefefefefefefefefefefefeffd87a80ff19012c581cc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c11a0036ee801a000aae60d87980ff"

const golden_closing_cbor: ByteArray =
  #"d8799f58200000000000000000000000000000000000000000000000000000000000000001582079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664d8799fd8799f581cb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1ffd8799fd8799fd8799f581cb5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5ffffffffd8799fd8799f581c5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5effd87a80ff581ce675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9490014df10745553444d194e2018645820ababababababababababababababababababababababababababababababababd8799fd8799f581cfefefefefefefefefefefefefefefefefefefefefefefefefefefefeffd87a80ff19012c581cc1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c11a0036ee801a000aae60d87a9f183e1b000001a10de66ed2ffff"

test datum_open_cbor_matches_ts() {
  let d: Data = datum(Open)
  cbor.serialise(d) == golden_open_cbor
}

test datum_closing_cbor_matches_ts() {
  let d: Data = datum(Closing { accepted: 62, contest_end: 1_791_234_567_890 })
  cbor.serialise(d) == golden_closing_cbor
}

// --- Interval semantics we rely on (don't trust the names) -----------------
// Close needs a FINITE upper bound; Raise needs is_entirely_before(contest_end);
// Settle needs is_entirely_after(contest_end). Open bounds must never pass.

test before_open_upper_bound_is_false() {
  !is_entirely_before(after(10), 1_000_000)
}

test before_everything_is_false() {
  !is_entirely_before(everything, 1_000_000)
}

test before_inclusive_upper_equal_to_point_is_false() {
  !is_entirely_before(between(10, 20), 20)
}

test before_inclusive_upper_below_point_is_true() {
  is_entirely_before(between(10, 20), 21)
}

test before_exclusive_upper_equal_to_point_is_true() {
  let r = Interval {
    lower_bound: IntervalBound { bound_type: Finite(10), is_inclusive: True },
    upper_bound: IntervalBound { bound_type: Finite(20), is_inclusive: False },
  }
  is_entirely_before(r, 20)
}

test before_negative_infinity_lower_is_fine() {
  is_entirely_before(before(20), 21)
}

test after_open_lower_bound_is_false() {
  !is_entirely_after(before(10), -1_000_000)
}

test after_everything_is_false() {
  !is_entirely_after(everything, -1_000_000)
}

test after_inclusive_lower_equal_to_point_is_false() {
  !is_entirely_after(between(10, 20), 10)
}

test after_inclusive_lower_above_point_is_true() {
  is_entirely_after(between(10, 20), 9)
}

test after_exclusive_lower_equal_to_point_is_true() {
  let r = Interval {
    lower_bound: IntervalBound { bound_type: Finite(10), is_inclusive: False },
    upper_bound: IntervalBound { bound_type: Finite(20), is_inclusive: True },
  }
  is_entirely_after(r, 10)
}

test after_positive_infinity_upper_is_fine() {
  is_entirely_after(after(10), 9)
}
