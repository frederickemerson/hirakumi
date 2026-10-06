use aiken/interval.{after, between}
use cardano/transaction.{OutputReference, Transaction}
use hirakumi/escrow
use hirakumi/fixtures.{
  buyer, buyer_vkh, close_hi, close_lo, closer_vkh, contest_end, continuing,
  datum, fee_address, lock_input, operator_input, own_ref, seller, tagged, tx,
}
use hirakumi/types.{Close, Closing, Open, PackDatum, PackRedeemer, Settle}

/// Hirakumi pack escrow. Unparameterized, one script address for every pack.
/// Lifecycle: Open --Close--> Closing --Raise*--> Closing --Settle--> paid out.
/// The rules live in `hirakumi/escrow.validate`.
validator pack_escrow {
  spend(
    datum: Option<PackDatum>,
    redeemer: PackRedeemer,
    own_ref: OutputReference,
    tx: Transaction,
  ) {
    expect Some(d) = datum
    escrow.validate(d, redeemer, own_ref, tx)
  }

  else(_) {
    fail
  }
}

// Handler-level tests: the typed datum/redeemer plumbing of the real entry point.

test spend_close_then_settle_through_the_handler() {
  let open = datum(Open)
  let closing = datum(Closing { accepted: 0, contest_end })
  and {
    pack_escrow.spend(
      Some(open),
      Close { accepted: 0, signature: #"" },
      own_ref,
      tx(
        [lock_input(open), operator_input()],
        [continuing(closing)],
        between(close_lo, close_hi),
        [buyer_vkh],
        300_000,
      ),
    ),
    pack_escrow.spend(
      Some(closing),
      Settle,
      own_ref,
      tx(
        [lock_input(closing)],
        [tagged(buyer(), 2_000_000, 1_600_000)],
        after(contest_end + 1),
        [closer_vkh],
        400_000,
      ),
    ),
  }
}

test spend_settle_split_through_the_handler() {
  let d = datum(Closing { accepted: 62, contest_end })
  pack_escrow.spend(
    Some(d),
    Settle,
    own_ref,
    tx(
      [lock_input(d)],
      [
        tagged(seller(), 1_202_800, 1_200_000),
        tagged(fee_address(), 37_200, 1_200_000),
        tagged(buyer(), 760_000, 1_600_000),
      ],
      after(contest_end + 1),
      [closer_vkh],
      400_000,
    ),
  )
}

test spend_rejects_missing_datum() fail {
  let d = datum(Closing { accepted: 0, contest_end })
  pack_escrow.spend(
    None,
    Settle,
    own_ref,
    tx(
      [lock_input(d)],
      [tagged(buyer(), 2_000_000, 1_600_000)],
      after(contest_end + 1),
      [closer_vkh],
      400_000,
    ),
  )
}
