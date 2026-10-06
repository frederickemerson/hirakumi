//// Test fixtures only. Nothing in the validator imports this module.
//// Hashes and keys are shared with packages/escrow/test/golden.ts.

use cardano/address.{
  Address, from_script, from_verification_key, with_delegation_key,
}
use cardano/assets.{Value}
use cardano/transaction.{
  InlineDatum, Input, NoDatum, Output, OutputReference, Transaction,
  ValidityRange, placeholder,
}
use hirakumi/types.{PackDatum, Stage}

pub const script_hash: ByteArray =
  #"5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c"

pub const buyer_vkh: ByteArray =
  #"b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"

pub const buyer_stake_vkh: ByteArray =
  #"b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5"

pub const seller_vkh: ByteArray =
  #"5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e"

pub const fee_vkh: ByteArray =
  #"fefefefefefefefefefefefefefefefefefefefefefefefefefefefe"

pub const closer_vkh: ByteArray =
  #"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"

pub const third_vkh: ByteArray =
  #"33333333333333333333333333333333333333333333333333333333"

pub const usdm_policy: ByteArray =
  #"e675b46e4d2242c991a8932a99db3044e80515ae14b4c4ccf6b3f4c9"

pub const usdm_name: ByteArray = #"0014df10745553444d"

pub const channel: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000001"

pub const other_channel: ByteArray =
  #"0000000000000000000000000000000000000000000000000000000000000002"

pub const rule: ByteArray =
  #"abababababababababababababababababababababababababababababababab"

/// ed25519 public key of the fixed secret key 0x0102…20 (TS: @noble/curves).
pub const golden_pk: ByteArray =
  #"79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"

/// TS-signed IOUs for `channel` (00..01). sig_7 is the cross-language golden vector.
pub const sig_7: ByteArray =
  #"cad601bc32747bf1e603e1b2cdd0a3bbb487b790b7e89c270ec6991f04ca7f0a3ee744595dff9ae7a395a4028bc061f8ae6d7c86c7ba5d10d7844e1088c1ba08"

pub const sig_8: ByteArray =
  #"777f8efaba4a14e83d05696f0978ed0e8986de8fa0b2d8b99e264acc74a450598ba4510d07c77749239cecf30b0cf44e06b198b421af24ca982e7b598eb38202"

pub const sig_62: ByteArray =
  #"c1384cb38544882ec99205dc4c1bc86d6b8ac4865019ad82542f67566357fc952cda40a7d9cc0723818c8864cd2bc796a9c10f781539c53143bb1db22f684307"

pub const sig_100: ByteArray =
  #"885e5f440cf84d72146e63f3c94154cb419aec4a6a4ade625b307973df34e21ffa22e0de726d5aa0237c7a59e90f8469bc5eeb826dfdbd5d3cb35297cb060d01"

pub const locked_tokens: Int = 2_000_000

pub const locked_lovelace: Int = 2_000_000

pub const contest_period: Int = 3_600_000

/// Close window used throughout: [1_000_000, 1_600_000] -> contest_end 5_200_000.
pub const close_lo: Int = 1_000_000

pub const close_hi: Int = 1_600_000

pub const contest_end: Int = 5_200_000

pub const own_ref: OutputReference =
  OutputReference {
    transaction_id: #"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    output_index: 0,
  }

pub fn script_address() -> Address {
  from_script(script_hash)
}

/// Base address: key payment part + key stake part.
pub fn buyer() -> Address {
  from_verification_key(buyer_vkh) |> with_delegation_key(buyer_stake_vkh)
}

/// Enterprise address.
pub fn seller() -> Address {
  from_verification_key(seller_vkh)
}

pub fn fee_address() -> Address {
  from_verification_key(fee_vkh)
}

pub fn datum(stage: Stage) -> PackDatum {
  PackDatum {
    channel_id: channel,
    receipt_key: golden_pk,
    buyer_refund: buyer(),
    seller: seller(),
    policy_id: usdm_policy,
    asset_name: usdm_name,
    price_per_call: 20_000,
    max_calls: 100,
    rule_hash: rule,
    fee_address: fee_address(),
    fee_bps: 300,
    closer: closer_vkh,
    contest_period,
    close_fee_budget: 700_000,
    stage,
  }
}

pub fn usdm(tokens: Int, lovelace: Int) -> Value {
  assets.from_lovelace(lovelace)
    |> assets.add(usdm_policy, usdm_name, tokens)
}

pub fn script_output(d: PackDatum, value: Value) -> Output {
  let d_data: Data = d
  Output {
    address: script_address(),
    value,
    datum: InlineDatum(d_data),
    reference_script: None,
  }
}

/// The spent lock: `locked_tokens` + `locked_lovelace` at the script.
pub fn lock_input(d: PackDatum) -> Input {
  lock_input_with(d, usdm(locked_tokens, locked_lovelace))
}

pub fn lock_input_with(d: PackDatum, value: Value) -> Input {
  Input { output_reference: own_ref, output: script_output(d, value) }
}

/// A second UTxO at the same script (another pack).
pub fn other_lock_input(d: PackDatum) -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      output_index: 3,
    },
    output: script_output(d, usdm(locked_tokens, locked_lovelace)),
  }
}

pub fn operator_input() -> Input {
  Input {
    output_reference: OutputReference {
      transaction_id: #"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      output_index: 1,
    },
    output: Output {
      address: from_verification_key(closer_vkh),
      value: assets.from_lovelace(10_000_000),
      datum: NoDatum,
      reference_script: None,
    },
  }
}

/// The continuing output of Close / Raise, same value as the lock.
pub fn continuing(d: PackDatum) -> Output {
  script_output(d, usdm(locked_tokens, locked_lovelace))
}

/// A payout tagged with inline datum = `channel`.
pub fn tagged(to: Address, tokens: Int, lovelace: Int) -> Output {
  let tag: Data = channel
  Output {
    address: to,
    value: usdm(tokens, lovelace),
    datum: InlineDatum(tag),
    reference_script: None,
  }
}

pub fn tx(
  inputs: List<Input>,
  outputs: List<Output>,
  validity_range: ValidityRange,
  extra_signatories: List<ByteArray>,
  fee: Int,
) -> Transaction {
  Transaction {
    ..placeholder,
    inputs,
    outputs,
    validity_range,
    extra_signatories,
    fee,
  }
}
