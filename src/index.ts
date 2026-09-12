import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { Hono } from "hono"
import { createMcpServer } from "./mcp.js"
import { AUTHORIZE_URL, DEFAULT_SCOPES } from "./oura.js"
import { OuraTokens, tokensFor as stub, type Env } from "./tokens.js"

const app = new Hono<{ Bindings: Env }>()
const same = async (actual: string | undefined, expected: string): Promise<boolean> => {
  if (actual === undefined) return false
  const encoder = new TextEncoder(), a = encoder.encode(actual), b = encoder.encode(expected)
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean }
  return a.byteLength === b.byteLength && subtle.timingSafeEqual(a, b)
}
const bearer = (header: string | undefined) => header?.startsWith("Bearer ") ? header.slice(7) : undefined

app.get("/", (c) => c.text("oura-mcp — MCP endpoint: /mcp"))
// Policy pages the Oura developer portal requires when registering an app (single-user personal tool).
app.get("/privacy/", (c) => c.text("Privacy: this is a personal, single-user tool. Oura data is fetched on demand for the owner only, never stored beyond OAuth tokens, and never shared."))
app.get("/tos", (c) => c.text("Terms: personal, single-user tool operated by its owner for their own Oura data. No service is offered to third parties."))
app.get("/health", async (c) => c.json({ ok: true, ...await stub(c.env).status() }))
app.get("/oauth/start", async (c) => {
  if (!await same(c.req.query("token"), c.env.MCP_BEARER)) return c.json({ error: "Unauthorized" }, 401)
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", c.env.OURA_CLIENT_ID)
  url.searchParams.set("redirect_uri", c.env.OURA_REDIRECT_URI)
  url.searchParams.set("scope", DEFAULT_SCOPES)
  url.searchParams.set("state", await stub(c.env).beginAuth())
  return c.redirect(url.toString())
})
app.get("/oauth/callback", async (c) => {
  const error = c.req.query("error")
  if (error) return c.text(`Authorization failed: ${error}`, 400)
  const code = c.req.query("code"), state = c.req.query("state")
  if (!code || !state) return c.text("Missing OAuth code or state.", 400)
  try {
    await stub(c.env).completeAuth(state, code)
    return c.html("<p>Oura authorized. You can close this tab.</p>")
  } catch (failure) {
    return c.text(failure instanceof Error ? failure.message : String(failure), 400)
  }
})
app.all("/mcp", async (c) => {
  if (!await same(bearer(c.req.header("Authorization")), c.env.MCP_BEARER))
    return c.json({ error: "Unauthorized" }, 401)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  const server = createMcpServer(c.env)
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

export { OuraTokens }
export default app
