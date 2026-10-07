# Demo price API

A read-only price API used as the demo seller for Hirakumi. `GET /openapi.json` is the spec Hirakumi reads.

## Proving ownership on Hirakumi

Listings prove ownership with a DNS TXT record (`_hirakumi.<host>`, value `hkv_...`) at the host's DNS provider, so nothing in this API is involved.

Listings proven before the DNS record existed sent the code as a response header, `X-Hirakumi-Verify: hkv_...`, and Hirakumi re-checks those by the header. This demo keeps sending it on every answer for them. Set it either way:

- **Env, survives restarts:** `HIRAKUMI_CHALLENGE='{"api_xxx":"hkv_..."}'`. When several entries are listed, the last one is sent.
- **Admin route, no redeploy:** `curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: text/plain" --data 'hkv_...' $PUBLIC_URL/admin/challenge/api_xxx` (kept in memory only).

## Break switch

`POST /admin/break {"mode":"ok"|"empty"|"stale"}` with `Authorization: Bearer $ADMIN_TOKEN`: `empty` answers `{}`, `stale` serves old data. It shows a broken promise (a free 422) and the Down state.

## Env

| Name | Use |
| --- | --- |
| `PUBLIC_URL` | `servers[0]` in the spec |
| `ADMIN_TOKEN` | enables `/admin/*` (break switch, verification code) |
| `HIRAKUMI_CHALLENGE` | `{"api_xxx":"hkv_..."}` verification codes; the last entry is sent as the header |
| `COINGECKO_API_KEY` | optional |
