use aiken/collection/list
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId, lovelace_of, quantity_of}
use cardano/transaction.{InlineDatum, Output}

/// What one address is owed at settlement.
pub type Obligation {
  to: Address,
  tokens: Int,
  lovelace: Int,
}

/// Merge obligations to equal addresses by summing them. Order of first
/// appearance is kept. With 3 obligations this is at most 3 comparisons.
pub fn aggregate(obligations: List<Obligation>) -> List<Obligation> {
  list.foldl(obligations, [], fn(o, acc) { add(acc, o) })
}

fn add(acc: List<Obligation>, o: Obligation) -> List<Obligation> {
  when acc is {
    [] -> [o]
    [x, ..rest] ->
      if x.to == o.to {
        [
          Obligation {
            to: x.to,
            tokens: x.tokens + o.tokens,
            lovelace: x.lovelace + o.lovelace,
          },
          ..rest
        ]
      } else {
        [x, ..add(rest, o)]
      }
  }
}

/// True when nothing is owed, or the SUM over all outputs to `o.to` that
/// carry inline datum `tag` covers both the tokens and the lovelace owed.
/// Because obligations are aggregated per address first, one output can
/// never be counted towards two obligations (double satisfaction).
pub fn satisfied(
  outputs: List<Output>,
  policy: PolicyId,
  name: AssetName,
  tag: Data,
  o: Obligation,
) -> Bool {
  if o.tokens <= 0 && o.lovelace <= 0 {
    True
  } else {
    let tagged = InlineDatum(tag)
    let (tokens, lovelace) = list.foldl(
      outputs,
      (0, 0),
      fn(out, totals) {
        if out.address == o.to && out.datum == tagged {
          let (t, l) = totals
          (t + quantity_of(out.value, policy, name), l + lovelace_of(out.value))
        } else {
          totals
        }
      },
    )
    tokens >= o.tokens && lovelace >= o.lovelace
  }
}
