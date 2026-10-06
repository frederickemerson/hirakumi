use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId}

/// Where a pack is in its life.
///
/// `Open` = Constr 0 []
/// `Closing { accepted, contest_end }` = Constr 1 [accepted, contest_end]
pub type Stage {
  Open
  Closing {
    /// Highest IOU count proven on-chain so far.
    accepted: Int,
    /// POSIX ms. Raise is allowed strictly before it, Settle strictly after.
    contest_end: Int,
  }
}

/// Inline datum of a pack lock. Constr 0, fields in this exact order.
pub type PackDatum {
  /// 32 bytes. Unique pack id; also the inline-datum tag on payouts.
  channel_id: ByteArray,
  /// 32 bytes. The buyer's ed25519 verification key for IOUs.
  receipt_key: ByteArray,
  /// Refund address. Its payment key hash is also the buyer's signing identity.
  buyer_refund: Address,
  seller: Address,
  policy_id: PolicyId,
  asset_name: AssetName,
  /// micros of the pack asset
  price_per_call: Int,
  max_calls: Int,
  /// 32 bytes. sha256 of the published promise. Informational.
  rule_hash: ByteArray,
  fee_address: Address,
  /// Hirakumi take rate in basis points; clamped to 0..1000 at settlement.
  fee_bps: Int,
  /// 28 bytes. Payment key hash of Hirakumi's operator wallet.
  closer: ByteArray,
  /// ms between a Close's upper validity bound and the earliest Settle.
  /// Values below `min_contest_period` (60 s) are treated as 60 s.
  contest_period: Int,
  /// Max lovelace a Settle may take from the buyer for the network fee. Only
  /// a Settle signed by `closer` or the buyer charges the buyer the fee (and
  /// must stay within this budget); any other settler pays the fee itself.
  close_fee_budget: Int,
  stage: Stage,
}

pub type PackRedeemer {
  /// Constr 0. Open -> Closing. Buyer or closer.
  Close { accepted: Int, signature: ByteArray }
  /// Constr 1. Closing -> Closing with a higher count. Anyone.
  Raise { accepted: Int, signature: ByteArray }
  /// Constr 2. Closing -> paid out. Anyone; the buyer pays the fee only if
  /// the closer or the buyer signed.
  Settle
}
