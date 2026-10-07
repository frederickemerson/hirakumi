# Demo price API

A read-only price API used as the demo seller for Hirakumi. `GET /openapi.json` is the spec Hirakumi reads.

## Proving ownership on Hirakumi

New listings prove ownership with a DNS TXT record (`_hirakumi.<host>`, value `hkv_...`), added at the host's DNS provider, so nothing in this API is involved. Listings proven before that sent the code as a response header, and Hirakumi still re-checks those by the header. This demo keeps sending it for them:

```
X-Hirakumi-Verify: hkv_...
```

This demo sends the header on every answer, 404s and errors included. One header carries one code, so the **latest code set** is the one sent. Set it either way:

- **Env, survives restarts:** `HIRAKUMI_CHALLENGE='{"api_xxx":"hkv_..."}'`. When several entries are listed, the last one is sent. Changing it needs a redeploy.
- **Admin route, no redeploy:** `curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: text/plain" --data 'hkv_...' $PUBLIC_URL/admin/challenge/api_xxx`. This is kept in memory only, so it is lost on restart and is not shared between serverless instances. Use the env for a deployed demo.

Copy the code from the API's ownership page on Hirakumi. The page checks the base URL every 10 s and unlocks the wallet signature once it finds the code. To check it yourself:

```
curl -s -o /dev/null -D - $PUBLIC_URL/ | grep -i x-hirakumi-verify
```

`servers[0]` in `/openapi.json` is `PUBLIC_URL`, so the API's base URL is the origin's root. Any status counts there, so the root's 404 carries the proof. The OpenAPI file itself holds no code.

## Env

| Name | Use |
| --- | --- |
| `PUBLIC_URL` | `servers[0]` in the spec |
| `ADMIN_TOKEN` | enables `/admin/*` (break switch, verification code) |
| `HIRAKUMI_CHALLENGE` | `{"api_xxx":"hkv_..."}` verification codes; the last entry is sent as the header |
| `COINGECKO_API_KEY` | optional |
