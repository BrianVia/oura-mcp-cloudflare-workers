import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod/v4"
import { buildUrl, COLLECTIONS, httpMessage, ouraDataParams, PROD_BASE, SANDBOX_BASE, type OuraDataParams } from "./oura.js"
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
  })
  let response = await request(await stub.getAccessToken())
  if (response.status === 401) {
    await stub.invalidate()
    response = await request(await stub.getAccessToken())
  }
  return response
}

const safeBody = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return text || undefined }
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
      const body = await safeBody(response)
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
      const end = new Date(), start = new Date(end.getTime() - days * 86_400_000)
      const range = { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) }
      const names = ["daily_sleep", "daily_readiness", "daily_activity", "daily_spo2", "sleep"] as const
      const results = await Promise.all(names.map(async (collection) => {
        const response = await ouraFetch(env, buildUrl(apiBase, { collection, ...range }, end))
        const body = await safeBody(response)
        if (!response.ok) throw new Error(httpMessage(response.status, body))
        return ((body as { data?: Record<string, unknown>[] }).data ?? [])
      }))
      const byDay = (rows: Record<string, unknown>[]) => new Map(rows.map((row) => [row.day as string, row]))
      const [sleepScore, readiness, activity, spo2, sleeps] = results.map(byDay)
      const sleepByDay = new Map<string, Record<string, unknown>>()
      for (const sleep of sleeps.values()) if (sleep.type === "long_sleep") {
        const prior = sleepByDay.get(sleep.day as string)
        if (!prior || Number(sleep.total_sleep_duration) > Number(prior.total_sleep_duration)) sleepByDay.set(sleep.day as string, sleep)
      }
      const daysFound = new Set([...sleepScore.keys(), ...readiness.keys(), ...activity.keys(), ...spo2.keys(), ...sleepByDay.keys()])
      const value = (record: Record<string, unknown> | undefined, key: string) => record?.[key] ?? null
      const rows = [...daysFound].sort().map((day) => {
        const detailed = sleepByDay.get(day), oxygen = spo2.get(day)?.spo2_percentage as Record<string, unknown> | undefined
        const seconds = value(detailed, "total_sleep_duration")
        return { day, sleep_score: value(sleepScore.get(day), "score"), readiness_score: value(readiness.get(day), "score"),
          activity_score: value(activity.get(day), "score"), steps: value(activity.get(day), "steps"), spo2_avg: oxygen?.average ?? null,
          hrv_avg: value(detailed, "average_hrv"), rhr: value(detailed, "lowest_heart_rate"),
          total_sleep_h: typeof seconds === "number" ? Math.round(seconds / 36) / 100 : null }
      })
      return { content: [{ type: "text", text: JSON.stringify(rows) }] }
    } catch (error) { return failed(error) }
  })
  return server
}
