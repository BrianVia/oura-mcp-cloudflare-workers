import assert from "node:assert/strict"
import test from "node:test"
import { buildUrl, ouraDataParams, PROD_BASE } from "../src/oura.ts"

const now = new Date("2026-06-15T12:00:00.000Z")
const params = (value: unknown) => ouraDataParams.parse(value)

test("buildUrl defaults daily collections to seven days", () => {
  const url = new URL(buildUrl(PROD_BASE, params({ collection: "daily_sleep" }), now))
  assert.equal(url.searchParams.get("start_date"), "2026-06-08")
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
