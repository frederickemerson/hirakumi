# Demo price API

A read-only price API used as the demo seller for Hirakumi. `GET /openapi.json` is the spec Hirakumi reads.

## Proving ownership on Hirakumi

Hirakumi asks a seller to add their API's verification code at the root of the OpenAPI file:

```yaml
x-hirakumi-verify: "hkv_..."
```

This demo serves the code inside `/openapi.json` (sent with `Cache-Control: no-store`). One spec carries one code, so the **latest code set** is the one served. Set it either way:

- **Env, survives restarts:** `HIRAKUMI_CHALLENGE='{"api_xxx":"hkv_..."}'`. When several entries are listed, the last one is served. Changing it needs a redeploy.
- **Admin route, no redeploy:** `curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: text/plain" --data 'hkv_...' $PUBLIC_URL/admin/challenge/api_xxx`. This is kept in memory only, so it is lost on restart and is not shared between serverless instances. Use the env for a deployed demo.

Copy the code from the API's ownership page on Hirakumi. The page checks the file every 10 s and unlocks the wallet signature once it finds the code.

The spec lives at the root (`/openapi.json`) and `servers[0]` is `PUBLIC_URL`, so it covers the whole origin. That is the directory rule Hirakumi enforces: a spec only proves ownership of APIs at or under its own folder.

## Env

| Name | Use |
| --- | --- |
| `PUBLIC_URL` | `servers[0]` in the spec |
| `ADMIN_TOKEN` | enables `/admin/*` (break switch, verification code) |
| `HIRAKUMI_CHALLENGE` | `{"api_xxx":"hkv_..."}` verification codes; the last entry is served |
| `COINGECKO_API_KEY` | optional |
