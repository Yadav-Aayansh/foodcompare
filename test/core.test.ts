import test from "node:test"
import assert from "node:assert/strict"
import {
  accountId,
  bestMatch,
  formatINR,
  matchScore,
  parseItemSpec,
  resolveAddress,
  UserError,
} from "../src/core.ts"

test("matchScore prefers exact and prefix matches", () => {
  assert.equal(matchScore("veg chow mein", "Veg Chow Mein"), 100)
  assert.ok(matchScore("chow", "Veg Chow Mein") > matchScore("roll", "Veg Chow Mein"))
  assert.ok(matchScore("veg chow", "Veg Chow Mein") >= 70)
})

test("bestMatch rejects weak matches", () => {
  const items = [{ name: "Veg Chow Mein" }, { name: "Spring Roll" }]
  assert.equal(bestMatch("chow mein", items, (item) => item.name)?.name, "Veg Chow Mein")
  assert.equal(bestMatch("pizza", items, (item) => item.name), undefined)
})

test("resolveAddress handles tag, id and ambiguity", () => {
  const addresses = [
    { id: "a1", line: "1 Main Road", tag: "Home" },
    { id: "a2", line: "2 Side Road", tag: "Home" },
    { id: "a3", line: "3 Work Road", tag: "Work" },
  ]
  assert.equal(resolveAddress(addresses, "a3").line, "3 Work Road")
  assert.equal(resolveAddress(addresses, "work").id, "a3")
  assert.throws(() => resolveAddress(addresses, "Home"), UserError)
  assert.throws(() => resolveAddress(addresses, "Nowhere"), UserError)
})

test("parseItemSpec splits only the final variant segment", () => {
  assert.deepEqual(parseItemSpec("Veg Chow Mein:Half"), { name: "Veg Chow Mein", variant: "Half" })
  assert.deepEqual(parseItemSpec("Veg Chow Mein"), { name: "Veg Chow Mein" })
  assert.deepEqual(parseItemSpec("Pizza:Margherita:Large"), { name: "Pizza:Margherita", variant: "Large" })
})

test("formatINR and accountId", () => {
  assert.equal(formatINR(175), "₹175")
  assert.equal(formatINR(25.48), "₹25.48")
  assert.equal(formatINR(null), "—")
  assert.equal(accountId("swiggy", "Dad's Phone"), "swiggy:dad-s-phone")
  assert.equal(accountId("swiggy", "!!!"), "swiggy:account")
})
