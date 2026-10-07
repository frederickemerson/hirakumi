# Mika's FX Rates (demo seller)

A read-only foreign exchange API used as a demo seller for Hirakumi, served at `mika.$PUBLIC_DOMAIN`. `GET /openapi.json` is the spec Hirakumi reads.

- `GET /rate?from=USD&to=EUR` → `{"from":"USD","to":"EUR","rate":0.889506,"asOf":"2026-10-07T01:51:01.627Z"}`
- `GET /convert?from=USD&to=JPY&amount=100` → `{"from":"USD","to":"JPY","amount":100,"result":15834.6,"rate":158.346,"asOf":"…"}`

Currencies: USD, EUR, GBP, JPY, SGD, CHF, AUD, CAD, INR, CNY, HKD, KRW. Rates have six significant digits; results four decimal places.

## Where the rates come from

Coinbase's public exchange rates (no key), cached for 30 s per base currency. They are undated, so `asOf` is when we fetched them. When Coinbase fails, ExchangeRate-API's open endpoint, which updates about once a day: `asOf` is then its own last update, so a freshness promise sees old data as old. A rate is never invented: the last real table is served with its real `asOf`, or 503 when there is none.

## Break switch

Same as `sellers/price-api` (see its README): `POST /admin/break {"mode":"ok"|"empty"|"stale"}` with `Authorization: Bearer $ADMIN_TOKEN` (`empty` answers `{}`, `stale` dates every rate two hours back). Ownership is a DNS TXT record at the host; the optional `X-Hirakumi-Verify` header (`HIRAKUMI_CHALLENGE` or `PUT /admin/challenge/api_xxx`) serves listings proven before DNS.

## Env

| Name | Use |
| --- | --- |
| `PUBLIC_URL` | `servers[0]` in the spec |
| `API_TITLE` | the spec's `info.title`, the listing's name (default "Mika's FX Rates") |
| `ADMIN_TOKEN` | enables `/admin/*` (break switch, verification code) |
| `API_KEY` | when set, `/rate` and `/convert` need it in `X-API-Key` (401 otherwise) and the spec declares it, so Hirakumi asks the seller for it; its publish gate needs this |
| `HIRAKUMI_CHALLENGE` | `{"api_xxx":"hkv_..."}` verification codes; the last entry is sent as the header |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | optional shared break-switch store (required on Vercel) |
