# oura-mcp

A remote [MCP](https://modelcontextprotocol.io/) server for your Oura Ring, running entirely on Cloudflare Workers. Deploy it, link your ring once, and any MCP client (Claude Code, Codex, curl) can ask about your sleep, readiness, HRV, activity, and SpO2.

- **No server to run.** One Worker + one Durable Object. Free tier is plenty for one person.
- **OAuth2 against Oura** (personal access tokens are deprecated). Tokens live only in Durable Object storage and are rotated automatically.
- **Two tools:** `oura_data` (every Oura API v2 collection) and `oura_brief` (compact daily summary in one call).
- ~400 lines of TypeScript, three dependencies (`hono`, `@modelcontextprotocol/sdk`, `zod`).

Single-user by design: one deployment = one ring. The MCP endpoint is protected by a static bearer token.

## How it works

```
MCP client ──Bearer──▶ /mcp (Worker, Hono) ──▶ Durable Object (OAuth tokens) ──▶ api.ouraring.com
                       /oauth/start ──▶ cloud.ouraring.com consent ──▶ /oauth/callback
```

The domain logic (collection table, parameter validation, URL building) is ported from MIT-licensed [jordanburke/oura-ring-mcp-server](https://github.com/jordanburke/oura-ring-mcp-server). Its Node shell (`node:fs` token file, local `node:http` login server, stdio transport) is replaced by Durable Object storage, `/oauth/*` routes, and the MCP SDK's web-standard Streamable HTTP transport. No `node:` imports anywhere.

## Setup

### 1. Pick a domain

Edit two lines in `wrangler.jsonc` to your own hostname on a zone you manage in Cloudflare:

```jsonc
"OURA_REDIRECT_URI": "https://oura.example.com/oauth/callback",
"routes": [{ "pattern": "oura.example.com", "custom_domain": true }]
```

The custom-domain route creates the DNS record on first deploy. No manual DNS.

### 2. Register an Oura app

At https://developer.ouraring.com create an app with:

- Redirect URI: exactly `https://oura.example.com/oauth/callback`
- Privacy Policy URL: `https://oura.example.com/privacy/`
- Terms of Service URL: `https://oura.example.com/tos`

(The Worker serves minimal placeholder pages at those two paths.) Save the Client ID and Client Secret. The app requests scopes: `email personal daily heartrate tag workout session spo2 ring_configuration stress heart_health`.

### 3. Deploy

```sh
npm i
npx wrangler login
npm run deploy                     # creates the Worker + DNS record
npx wrangler secret put OURA_CLIENT_ID
npx wrangler secret put OURA_CLIENT_SECRET
openssl rand -hex 32 | tee /dev/stderr | npx wrangler secret put MCP_BEARER   # keep the printed value
```

### 4. Link your ring (once)

Open `https://oura.example.com/oauth/start?token=<MCP_BEARER>` in a browser and approve. Then:

```sh
curl -s https://oura.example.com/health   # → {"ok":true,"authorized":true,...}
```

### 5. Connect a client

```sh
claude mcp add -s user --transport http oura https://oura.example.com/mcp --header "Authorization: Bearer <MCP_BEARER>"
```

Any other MCP client: HTTP transport, same URL, same header.

## Tools

**`oura_brief`** — `{ "days": 7 }` (1–30). One row per day: `sleep_score`, `readiness_score`, `activity_score`, `steps`, `spo2_avg`, `hrv_avg`, `rhr`, `total_sleep_h`. `null` where Oura hasn't produced the value yet. Costs 5 upstream calls.

**`oura_data`** — `{ "collection": "...", ...range }`. Raw Oura API v2 passthrough.

| Collection | Range params |
|---|---|
| `daily_sleep` `daily_readiness` `daily_activity` `daily_spo2` `daily_stress` `daily_resilience` `daily_cardiovascular_age` `vO2_max` `sleep` `sleep_time` `session` `workout` `tag` `enhanced_tag` `rest_mode_period` | `start_date`, `end_date` (YYYY-MM-DD; default last 7 days) |
| `heartrate` `ring_battery_level` | `start_datetime`, `end_datetime` (ISO-8601; default last 24 h) or `latest: true` |
| `personal_info` `ring_configuration` | none |

Plus `document_id`, `next_token`, `fields` where the collection supports them. Invalid combinations are rejected with a readable message.

## Raw HTTP

Stateless Streamable HTTP: one POST per call, no session.

```sh
curl -s https://oura.example.com/mcp -X POST \
  -H 'Authorization: Bearer <MCP_BEARER>' -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"oura_brief","arguments":{"days":7}}}'
```

The response is SSE-framed (`data: {...}`); `result.content[0].text` is a JSON string, `result.isError: true` means it's an error message.

## Local development

```sh
cp .dev.vars.example .dev.vars   # dummy values are fine for unauthenticated checks
npm run check                    # tsc + tests
npx wrangler dev                 # http://localhost:8787
```

## Notes and limits

- Oura rate limit: 5000 requests / 5 min. Don't poll.
- `OURA_SANDBOX=true` in `wrangler.jsonc` `vars` switches to Oura's demo data (no ring needed).
- claude.ai web connectors need OAuth on the MCP side, not a static bearer; not supported. Put [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) in front if you need that.
- `/oauth/start` takes the bearer as a query parameter, so it lands in browser history. Acceptable for one user; rotate with `wrangler secret put MCP_BEARER` if it leaks.
- No cache. Every tool call hits Oura live. Add D1/KV only if rate limits bite.

## License

MIT. See [LICENSE](LICENSE) — includes the upstream copyright for the ported domain code.
