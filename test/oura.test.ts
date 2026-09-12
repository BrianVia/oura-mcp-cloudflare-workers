import assert from "node:assert/strict"
import test from "node:test"
import { buildUrl, ouraDataParams, PROD_BASE, summarize } from "../src/oura.ts"

const now = new Date("2026-06-15T12:00:00.000Z")
const params = (value: unknown) => ouraDataParams.parse(value)

test("buildUrl defaults daily collections to seven days", () => {
  const url = new URL(buildUrl(PROD_BASE, params({ collection: "daily_sleep" }), now))
  assert.equal(url.searchParams.get("start_date"), "2026-06-09")
  assert.equal(url.searchParams.get("end_date"), "2026-06-15")
})

test("buildUrl defaults datetime collections to 24 hours", () => {
  const url = new URL(buildUrl(PROD_BASE, params({ collection: "heartrate" }), now))
  assert.equal(url.searchParams.get("start_datetime"), "2026-06-14T12:00:00.000Z")
  assert.equal(url.searchParams.get("end_datetime"), now.toISOString())
})

test("buildUrl encodes a document id in the path", () => {
  assert.equal(buildUrl(PROD_BASE, params({ collection: "sleep", document_id: "abc 123" }), now), `${PROD_BASE}/sleep/abc%20123`)
})

test("params reject latest on daily and dates on singleton collections", () => {
  assert.equal(ouraDataParams.safeParse({ collection: "daily_sleep", latest: true }).success, false)
  assert.equal(ouraDataParams.safeParse({ collection: "personal_info", start_date: "2026-06-01" }).success, false)
})

test("summarize uses the longest long sleep and leaves missing collections null", () => {
  assert.deepEqual(summarize({
    dailySleep: [{ day: "2026-06-15", score: 90 }], readiness: [], activity: [], spo2: [],
    sleeps: [
      { day: "2026-06-15", type: "long_sleep", total_sleep_duration: 25_000, average_hrv: 80, lowest_heart_rate: 45 },
      { day: "2026-06-15", type: "long_sleep", total_sleep_duration: 3_600, average_hrv: 60, lowest_heart_rate: 55 },
    ],
  }), [{ day: "2026-06-15", sleep_score: 90, readiness_score: null, activity_score: null, steps: null,
    spo2_avg: null, hrv_avg: 80, rhr: 45, total_sleep_h: 6.94 }])
})
