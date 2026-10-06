use aiken/builtin
use aiken/primitive/bytearray

/// "HKR1"
pub const prefix: ByteArray = #"484b5231"

/// 44 bytes: "HKR1" ‖ channel_id(32) ‖ accepted as 8-byte unsigned big-endian.
/// Fails (never wraps) when `accepted` is negative or doesn't fit 8 bytes.
pub fn iou_message(channel_id: ByteArray, accepted: Int) -> ByteArray {
  prefix
    |> bytearray.concat(channel_id)
    |> bytearray.concat(bytearray.from_int_big_endian(accepted, 8))
}

/// Raw ed25519 over the 44-byte message. The builtin fails on a key that
/// isn't 32 bytes or a signature that isn't 64, which rejects the tx.
pub fn iou_valid(
  key: ByteArray,
  channel_id: ByteArray,
  accepted: Int,
  signature: ByteArray,
) -> Bool {
  builtin.verify_ed25519_signature(
    key,
    iou_message(channel_id, accepted),
    signature,
  )
}
