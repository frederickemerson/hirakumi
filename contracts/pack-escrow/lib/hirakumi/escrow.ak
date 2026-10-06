use aiken/collection/list
use aiken/interval.{Finite, is_entirely_after, is_entirely_before}
use aiken/math
use cardano/address.{Address, VerificationKey}
use cardano/assets.{Value, lovelace_of, quantity_of, without_lovelace}
use cardano/transaction.{
  InlineDatum, Output, OutputReference, Transaction, find_input,
}
use hirakumi/iou.{iou_valid}
use hirakumi/payout.{Obligation, aggregate, satisfied}
use hirakumi/types.{
  Close, Closing, Open, PackDatum, PackRedeemer, Raise, Settle,
}

pub const max_fee_bps: Int = 1000

/// Longest validity range (ms) a Close tx may have. `contest_end` is computed
/// from the upper bound, so without a cap a Close could push it arbitrarily far.
pub const max_close_window: Int = 3_600_000

/// Shortest contest window (ms) a Close starts, whatever the datum says.
/// Clamped, not rejected, so a nonsense datum can't block the buyer's exit.
pub const min_contest_period: Int = 60_000

/// Settlement arithmetic. Clamps, never rejects, so a nonsense datum can't
/// block the buyer's exit. Returns (seller_net, fee, buyer_tokens).
///   seller_gross = clamp(accepted × price, 0, locked_tokens)
///   fee          = seller_gross × clamp(fee_bps, 0, 1000) / 10000   (floor)
pub fn split(
  accepted: Int,
  price_per_call: Int,
  fee_bps: Int,
  locked_tokens: Int,
) -> (Int, Int, Int) {
  let gross = math.clamp(accepted * price_per_call, 0, locked_tokens)
  let fee = gross * math.clamp(fee_bps, 0, max_fee_bps) / 10000
  (gross - fee, fee, locked_tokens - gross)
}

pub fn validate(
  d: PackDatum,
  redeemer: PackRedeemer,
  own_ref: OutputReference,
  tx: Transaction,
) -> Bool {
  expect Some(own) = find_input(tx.inputs, own_ref)
  let own_address = own.output.address
  let own_value = own.output.value

  // Double-satisfaction guard: this is the only input at this script.
  let script_inputs = list.count(
    tx.inputs,
    fn(i) {
      i.output.address.payment_credential == own_address.payment_credential
    },
  )
  expect script_inputs == 1

  let locked_tokens = quantity_of(own_value, d.policy_id, d.asset_name)

  when redeemer is {
    Close { accepted, signature } -> {
      expect Open = d.stage
      expect Finite(lower) = tx.validity_range.lower_bound.bound_type
      expect Finite(upper) = tx.validity_range.upper_bound.bound_type
      and {
        upper - lower <= max_close_window,
        signed_by_buyer(d.buyer_refund, tx.extra_signatories) || list.has(
          tx.extra_signatories,
          d.closer,
        ),
        close_count_ok(d, locked_tokens, accepted, signature),
        continues(
          tx.outputs,
          own_address,
          own_value,
          PackDatum {
            ..d,
            stage: Closing {
              accepted,
              contest_end: upper + math.max(
                d.contest_period,
                min_contest_period,
              ),
            },
          },
        ),
      }
    }

    Raise { accepted, signature } -> {
      expect Closing { accepted: current, contest_end } = d.stage
      and {
        accepted > current,
        accepted <= d.max_calls,
        accepted * d.price_per_call <= locked_tokens,
        iou_valid(d.receipt_key, d.channel_id, accepted, signature),
        is_entirely_before(tx.validity_range, contest_end),
        continues(
          tx.outputs,
          own_address,
          own_value,
          PackDatum { ..d, stage: Closing { accepted, contest_end } },
        ),
      }
    }

    Settle -> {
      expect Closing { accepted, contest_end } = d.stage
      let (seller_net, fee, buyer_tokens) = split(
        accepted,
        d.price_per_call,
        d.fee_bps,
        locked_tokens,
      )
      let tag: Data = d.channel_id
      // The buyer pays the network fee only for a Settle that Hirakumi's
      // closer or the buyer signed. Anyone else settles at their own cost,
      // so an unrelated tx can't spend the buyer's lovelace on its fee.
      let charged = list.has(tx.extra_signatories, d.closer) || signed_by_buyer(
        d.buyer_refund,
        tx.extra_signatories,
      )
      let fee_charge = if charged {
        tx.fee
      } else {
        0
      }
      let owed = aggregate(
        [
          Obligation { to: d.seller, tokens: seller_net, lovelace: 0 },
          Obligation { to: d.fee_address, tokens: fee, lovelace: 0 },
          Obligation {
            to: d.buyer_refund,
            tokens: buyer_tokens,
            lovelace: lovelace_of(own_value) - fee_charge,
          },
        ],
      )
      and {
        is_entirely_after(tx.validity_range, contest_end),
        !charged || tx.fee <= d.close_fee_budget,
        list.all(
          owed,
          fn(o) { satisfied(tx.outputs, d.policy_id, d.asset_name, tag, o) },
        ),
        foreign_paid_to_buyer(d, own_value, locked_tokens, tag, tx.outputs),
      }
    }
  }
}

/// Any asset in the lock other than lovelace and the pack token (a donation,
/// or dust sent to the script) goes back to the buyer, in tagged outputs to
/// `buyer_refund`. It never includes the pack token or lovelace, so nothing
/// here is counted twice with the obligations.
fn foreign_paid_to_buyer(
  d: PackDatum,
  own_value: Value,
  locked_tokens: Int,
  tag: Data,
  outputs: List<Output>,
) -> Bool {
  let foreign = own_value
    |> without_lovelace
    |> assets.add(d.policy_id, d.asset_name, 0 - locked_tokens)
  if assets.is_zero(foreign) {
    True
  } else {
    let tagged = InlineDatum(tag)
    let paid = list.foldl(
      outputs,
      assets.zero,
      fn(o, acc) {
        if o.address == d.buyer_refund && o.datum == tagged {
          assets.merge(acc, o.value)
        } else {
          acc
        }
      },
    )
    list.all(
      assets.flatten(foreign),
      fn(asset) {
        let (p, n, q) = asset
        quantity_of(paid, p, n) >= q
      },
    )
  }
}

/// The payment key hash of the refund address signed the tx. A script
/// payment credential can't sign, so it is simply never "the buyer".
fn signed_by_buyer(buyer_refund: Address, signers: List<ByteArray>) -> Bool {
  when buyer_refund.payment_credential is {
    VerificationKey(vkh) -> list.has(signers, vkh)
    _ -> False
  }
}

/// accepted == 0 is always allowed and needs no signature, so the buyer can
/// always exit whatever the datum says. Otherwise the IOU must be in range,
/// covered by the locked tokens, and signed by `receipt_key`.
fn close_count_ok(
  d: PackDatum,
  locked_tokens: Int,
  accepted: Int,
  signature: ByteArray,
) -> Bool {
  if accepted == 0 {
    True
  } else {
    and {
      accepted > 0,
      accepted <= d.max_calls,
      accepted * d.price_per_call <= locked_tokens,
      iou_valid(d.receipt_key, d.channel_id, accepted, signature),
    }
  }
}

/// Exactly one output pays this script's payment credential, and it:
/// - is at the very same address (same stake part),
/// - carries exactly the same non-ADA assets and at least as much lovelace,
/// - holds `next` as its inline datum,
/// - has no reference script (it would inflate the next spend's fee past
///   `close_fee_budget` and could block Settle).
fn continues(
  outputs: List<Output>,
  own_address: Address,
  own_value: Value,
  next: PackDatum,
) -> Bool {
  expect [o] = list.filter(
    outputs,
    fn(out) { out.address.payment_credential == own_address.payment_credential },
  )
  let next_data: Data = next
  and {
    o.address == own_address,
    without_lovelace(o.value) == without_lovelace(own_value),
    lovelace_of(o.value) >= lovelace_of(own_value),
    o.datum == InlineDatum(next_data),
    o.reference_script == None,
  }
}
