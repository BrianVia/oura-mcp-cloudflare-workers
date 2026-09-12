import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod/v4"
import { buildUrl, COLLECTIONS, httpMessage, ouraDataParams, PROD_BASE, readBody, SANDBOX_BASE, summarize, type OuraDataParams } from "./oura.js"
import { tokensFor, type Env } from "./tokens.js"

const catalogue = COLLECTIONS.map((c) => `- ${c.name}: ${c.description}`).join("\n")
const description = `Fetch data from the Oura Ring API v2.

Pick a \`collection\` and provide the matching date range:
- Daily collections use \`start_date\`/\`end_date\` (YYYY-MM-DD). If both are omitted, the last 7 days are returned.
- Time-series collections (heartrate, ring_battery_level) use \`start_datetime\`/\`end_datetime\` (ISO-8601), or \`latest: true\`.
- \`personal_info\` takes no parameters; \`ring_configuration\` is a plain list.
- Any list collection with a document id can be fetched directly via \`document_id\`.
Large lists paginate: pass the returned \`next_token\` to fetch the next page.

Available collections:
${catalogue}`

export async function ouraFetch(env: Env, url: string): Promise<Response> {
  const stub = tokensFor(env)
  const request = (token: string) => fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  })
  let response = await request(await stub.getAccessToken())
  if (response.status === 401) {
    await stub.invalidate()
    response = await request(await stub.getAccessToken())
  }
  return response
}

const failed = (error: unknown) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
})

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer({ name: "oura-mcp", version: "0.1.0" })
  const apiBase = env.OURA_SANDBOX === "true" ? SANDBOX_BASE : PROD_BASE

  server.registerTool("oura_data", {
    description,
    inputSchema: ouraDataParams,
    annotations: { readOnlyHint: true, openWorldHint: true, title: "Oura Ring data" },
  }, async (params: OuraDataParams) => {
    try {
      const response = await ouraFetch(env, buildUrl(apiBase, params, new Date()))
      const body = await readBody(response)
      if (!response.ok) return failed(httpMessage(response.status, body))
      return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] }
    } catch (error) { return failed(error) }
  })

  server.registerTool("oura_brief", {
    description: "Summarize recent Oura sleep, readiness, activity, SpO2, HRV, and resting heart rate by day.",
    inputSchema: { days: z.number().int().min(1).max(30).default(7) },
    annotations: { readOnlyHint: true, title: "Oura health brief" },
  }, async ({ days }) => {
    try {
      const end = new Date(), start = new Date(end.getTime() - (days - 1) * 86_400_000) // inclusive range: days rows incl. today
      const range = { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) }
      const names = ["daily_sleep", "daily_readiness", "daily_activity", "daily_spo2", "sleep"] as const
      const results = await Promise.all(names.map(async (collection) => {
        const response = await ouraFetch(env, buildUrl(apiBase, { collection, ...range }, end))
        const body = await readBody(response)
        if (!response.ok) throw new Error(httpMessage(response.status, body))
        return ((body as { data?: Record<string, unknown>[] }).data ?? [])
      }))
      const [dailySleep, readiness, activity, spo2, sleeps] = results
      const rows = summarize({ dailySleep, readiness, activity, spo2, sleeps })
      return { content: [{ type: "text", text: JSON.stringify(rows) }] }
    } catch (error) { return failed(error) }
  })
  return server
}
