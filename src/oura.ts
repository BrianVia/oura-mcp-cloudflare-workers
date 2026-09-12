import { z } from "zod/v4"

export const PROD_BASE = "https://api.ouraring.com/v2/usercollection"
export const SANDBOX_BASE = "https://api.ouraring.com/v2/sandbox/usercollection"
export const TOKEN_URL = "https://api.ouraring.com/oauth/token"
export const AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize"
export const DEFAULT_SCOPES = "email personal daily heartrate tag workout session spo2 ring_configuration stress heart_health"

export type CollectionDescriptor = {
  readonly name: string
  readonly kind: "daily" | "datetime" | "listOnly" | "singleton"
  readonly byId: boolean
  readonly latest: boolean
  readonly description: string
}

const daily = (name: string, description: string): CollectionDescriptor =>
  ({ name, kind: "daily", byId: true, latest: false, description })
const datetime = (name: string, description: string): CollectionDescriptor =>
  ({ name, kind: "datetime", byId: false, latest: true, description })

export const COLLECTIONS: readonly CollectionDescriptor[] = [
  daily("daily_activity", "Daily activity summary: steps, calories, activity score."),
  daily("daily_sleep", "Daily sleep summary and sleep score."),
  daily("daily_readiness", "Daily readiness summary and readiness score."),
  daily("daily_spo2", "Daily average blood oxygen (SpO2) percentage."),
  daily("daily_stress", "Daily stress and recovery high/normal durations."),
  daily("daily_resilience", "Daily resilience level derived from recovery metrics."),
  daily("daily_cardiovascular_age", "Daily cardiovascular age estimate."),
  daily("vO2_max", "VO2 max (cardiorespiratory fitness) estimates."),
  daily("sleep", "Detailed per-period sleep sessions (stages, HRV, heart rate)."),
  daily("sleep_time", "Recommended/ideal bedtime windows."),
  daily("session", "Guided/unguided moment sessions (meditation, breathing, rest)."),
  daily("workout", "Recorded workouts with intensity, calories, and duration."),
  daily("tag", "Legacy user-entered tags."),
  daily("enhanced_tag", "Enhanced user-entered tags (current tag model)."),
  daily("rest_mode_period", "Rest mode periods (recovery/illness) the user enabled."),
  datetime("heartrate", "Time-series heart rate samples."),
  datetime("ring_battery_level", "Time-series ring battery level samples."),
  { name: "ring_configuration", kind: "listOnly", byId: true, latest: false,
    description: "Ring hardware configuration records (size, color, firmware, design)." },
  { name: "personal_info", kind: "singleton", byId: false, latest: false,
    description: "The user's personal info: age, weight, height, biological sex, email." },
] as const

export const COLLECTION_NAMES = COLLECTIONS.map((c) => c.name) as [string, ...string[]]
const BY_NAME = new Map(COLLECTIONS.map((c) => [c.name, c]))
export const getCollection = (name: string): CollectionDescriptor | undefined => BY_NAME.get(name)

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a calendar date in YYYY-MM-DD format.")
const dateTimeString = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  "Expected an ISO-8601 datetime, e.g. 2026-06-01T00:00:00+00:00.")

export const ouraDataParams = z.object({
  collection: z.enum(COLLECTION_NAMES).describe("Which Oura data collection to fetch."),
  start_date: dateString.optional().describe("Start date (inclusive) for daily collections."),
  end_date: dateString.optional().describe("End date (inclusive) for daily collections."),
  start_datetime: dateTimeString.optional().describe("Start datetime for time-series collections."),
  end_datetime: dateTimeString.optional().describe("End datetime for time-series collections."),
  document_id: z.string().optional().describe("Fetch a single document by id."),
  next_token: z.string().optional().describe("Pagination cursor from a previous response."),
  latest: z.boolean().optional().describe("Return only the most recent time-series sample."),
  fields: z.string().optional().describe("Comma-separated sparse fieldset."),
}).superRefine((val, ctx) => {
  const descriptor = getCollection(val.collection)!
  const reject = (field: keyof typeof val, message: string) => {
    if (val[field] !== undefined) ctx.addIssue({ code: "custom", message, path: [field] })
  }
  if (val.document_id !== undefined) {
    if (!descriptor.byId) reject("document_id", `The "${val.collection}" collection does not support fetching a single document by id.`)
    for (const field of ["start_date", "end_date", "start_datetime", "end_datetime", "next_token", "latest", "fields"] as const)
      reject(field, `Do not combine document_id with ${field}.`)
    return
  }
  const noParams = (message: string) => {
    for (const field of ["start_date", "end_date", "start_datetime", "end_datetime", "next_token", "latest", "fields"] as const)
      reject(field, message)
  }
  if (descriptor.kind === "singleton") noParams(`The "${val.collection}" collection takes no parameters.`)
  else if (descriptor.kind === "listOnly") {
    for (const field of ["start_date", "end_date", "start_datetime", "end_datetime"] as const)
      reject(field, `The "${val.collection}" collection is not filtered by date.`)
    reject("latest", `The "${val.collection}" collection does not support latest.`)
  } else if (descriptor.kind === "daily") {
    reject("start_datetime", `The "${val.collection}" collection uses dates, not datetimes.`)
    reject("end_datetime", `The "${val.collection}" collection uses dates, not datetimes.`)
    reject("latest", `The "${val.collection}" collection does not support latest.`)
  } else {
    reject("start_date", `The "${val.collection}" collection uses datetimes, not dates.`)
    reject("end_date", `The "${val.collection}" collection uses datetimes, not dates.`)
  }
})

export type OuraDataParams = z.infer<typeof ouraDataParams>
const DAY_MS = 86_400_000
const fmtDate = (date: Date) => date.toISOString().slice(0, 10)

export const buildUrl = (apiBase: string, params: OuraDataParams, now: Date): string => {
  const descriptor = getCollection(params.collection)
  if (!descriptor) throw new Error(`Unknown collection "${params.collection}"`)
  const base = `${apiBase}/${descriptor.name}`
  if (descriptor.kind === "singleton") return base
  if (params.document_id) return `${base}/${encodeURIComponent(params.document_id)}`
  const q = new URLSearchParams()
  if (descriptor.kind === "daily") {
    if (params.start_date === undefined && params.end_date === undefined) {
      q.set("start_date", fmtDate(new Date(now.getTime() - 7 * DAY_MS)))
      q.set("end_date", fmtDate(now))
    } else {
      if (params.start_date !== undefined) q.set("start_date", params.start_date)
      if (params.end_date !== undefined) q.set("end_date", params.end_date)
    }
  } else if (descriptor.kind === "datetime") {
    if (params.start_datetime === undefined && params.end_datetime === undefined && !params.latest) {
      q.set("start_datetime", new Date(now.getTime() - DAY_MS).toISOString())
      q.set("end_datetime", now.toISOString())
    } else {
      if (params.start_datetime !== undefined) q.set("start_datetime", params.start_datetime)
      if (params.end_datetime !== undefined) q.set("end_datetime", params.end_datetime)
    }
    if (params.latest) q.set("latest", "true")
  }
  if (params.next_token !== undefined) q.set("next_token", params.next_token)
  if (params.fields !== undefined) q.set("fields", params.fields)
  return q.size ? `${base}?${q}` : base
}

export const httpMessage = (status: number, detail: unknown): string => {
  const suffix = detail == null ? "" : ` ${JSON.stringify(detail)}`
  const messages: Record<number, string> = {
    400: "Oura rejected the request as invalid (400).",
    401: "Oura authentication failed (401) even after refreshing. Re-authorize the app.",
    403: "Oura denied access (403). The token may lack the required scope for this collection.",
    404: "Oura returned not found (404). The document_id may be wrong or unavailable.",
    422: "Oura could not process the parameters (422).",
    429: "Oura rate limit exceeded (429). Wait and retry with a narrower date range.",
  }
  return `${messages[status] ?? `Oura request failed with HTTP ${status}.`}${suffix}`
}
