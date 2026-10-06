// Library entry for other workspace packages (the gateway's live demo purchase). No CLI or .env side effects.
export { createPackPayer, PackPurchaseError, PaymentNotSentError, type EscrowPurchase, type OfferCheck, type PackPurchase, type SignedHook } from "./payClient.js";
export { checkDirectOffer, checkEscrowOffer, EscrowOfferError, offerMode, offerReasons } from "./escrowPack.js";
export { recoverPack, type RecoverResult } from "./packBuyer.js";
export { choosePack, formatMicros, NoAffordablePackError, parseCreditsRequired, type CreditsRequired, type FetchLike, type PackOffer } from "./gatewayClient.js";
export { fetchWalletBalance, type WalletBalance } from "./walletBalance.js";
