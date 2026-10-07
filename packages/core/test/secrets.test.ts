import { describe, expect, it } from "vitest";
import { isKeyParamName, looksLikeSecret } from "../src/secrets";

// Made up, and split so secret scanners do not read it as a real HubSpot key.
const FAKE_HUBSPOT_KEY = ["pat", "na1", "11111111-2222-3333-4444-555555555555"].join("-");

describe("looksLikeSecret", () => {
  it.each([
    "my api key: 9f8e7d6c5b4a3210",
    "X-API-Key=abcd1234efgh5678",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
    "GET /price?symbol=ADA&apikey=a1b2c3d4e5f6",
    "GET /price?symbol=ADA&key=a1b2c3d4e5f6g7",
    "GET /quote?token=c1a2b3c4d5e6f7g8h9i0j1k2",
    "token = ghp_abcdefghijklmnopqrstuvwxyz0123",
    "use sk-proj-abcdefghijklmnop1234 please",
    "password: s3cretpassw0rd",
    // A credential word inside a longer name, where '_' is a separator.
    "my x_cg_demo_api_key is CG-q1W2e3R4t5Y6u7I8o9P0aSdF",
    "CMC_PRO_API_KEY: 3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b",
    "GET /v2/translate?auth_key=3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b:fx",
    "Ocp-Apim-Subscription-Key: 0123456789abcdef0123456789abcdef",
    `GET /contacts?hapikey=${FAKE_HUBSPOT_KEY}`,
    '{"x-api-token": "a1b2c3d4e5f6g7h8"}',
    // Key formats stay refused under the weak names too.
    "GET /x?token=sk_live_abcdefghijkl1234",
    "GET /x?token=ghp_abcdefghijklmnopqrstuvwxyz0123",
    "GET /x?sig=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc",
    "GET /x?token=AKIAABCDEFGHIJKLMNOP",
    "GET /x?token=Ab3$kLm9_Qw2-Zx7+Yt5Rr8Pp",
  ])("flags %j", (text) => expect(looksLikeSecret(text)).toBe(true));

  it.each([
    "sell 1 2",
    "My API needs an api key: required in the X-API-Key header",
    "GET /price?symbol=ADA&apikey=YOUR_KEY",
    "Authorization: Bearer <token>",
    "https://api.x.dev/v1\nGET /coins/{id=cardano}?vs=usd",
    // Ordinary inputs of crypto APIs: a token contract, a ticker, a transaction signature, a Cardano asset.
    "https://api.example.com\nGET /quote?token=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "GET /price?token=cardano12",
    "GET /verify?signature=abcdef123456",
    "GET /verify?signature=0x5e1a3b9c0d7f2e4a6b8c1d3e5f7a9b0c2d4e6f8a1b3c5d7e9f0a2b4c6d8e0f1a2b",
    "GET /asset?token=asset1rjklcrnsdzqp65wjgrg55sy9723kw09mlgvlc3",
    // On-chain ids under token: a Cardano policy.assetName unit, a Solana mint, a TRON address, bech32, an ENS name.
    "GET /asset?token=1d7f33bd23d85e1a25d87d86fac4f199c3197a2f7afeb662a0f34e1e.776f726c646d6f62696c65746f6b656e",
    "GET /price?token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "GET /balance?token=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    "GET /utxos?token=addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
    "GET /utxos?token=addr_test1vrgvs0dkrtnm4uxpq5fu4e5gm0jvqhp6xlyq6dnwvzk0cqs5yhtyn",
    "GET /owner?token=vitalik2024wallet.eth",
    "from_token: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "GET /x?public_key=ed25519_pk1abcdefgh12345678",
  ])("does not flag %j", (text) => expect(looksLikeSecret(text)).toBe(false));
});

describe("isKeyParamName", () => {
  it.each([
    "key", "api_key", "apikey", "API-Key", "access_token", "client_secret", "appid",
    // Real names from public APIs: CoinGecko, CoinMarketCap, DeepL, Azure APIM, HubSpot, OpenWeather.
    "x_cg_demo_api_key", "x_cg_pro_api_key", "CMC_PRO_API_KEY", "auth_key", "subscription-key", "Ocp-Apim-Subscription-Key",
    "hapikey", "x-api-token", "openweather_appid", "xApiKey", "APIKey2", "secret_key", "db_password", "id_token",
    "api_token", "basic_auth", "x-auth", "clientSecret",
  ])("%s is a key", (n) => expect(isKeyParamName(n)).toBe(true));
  it.each([
    "token", "symbol", "signature", "sig", "keyword", "keywords", "keys", "monkey", "turkey", "hotkey", "id", "key_hash",
    "key_type", "public_key", "pubkey", "stake_key", "sort_key", "idempotency_key", "token_id", "token_address", "tokenAddress",
    "from_token", "base_token", "tokens", "author", "oauth_provider",
  ])("%s is not", (n) => expect(isKeyParamName(n)).toBe(false));
});
