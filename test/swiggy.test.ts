import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { swiggyQuote } from "../src/swiggy.ts"
import type { Account } from "../src/core.ts"
import { UserError, nowSec } from "../src/core.ts"

type CartState = { cart: any }

function itemFor(id: string, name: string) {
  return { menu_item_id: id, name, price: id === "m1" ? 150 : 180 }
}

function mockSwiggy(state: CartState) {
  const calls: { name: string; args: any }[] = []
  const server = http.createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      const message = JSON.parse(body)
      if (!message.id) {
        response.writeHead(202).end()
        return
      }
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "0" } },
          }),
        )
        return
      }
      const { name, arguments: args } = message.params
      calls.push({ name, args })
      let result: any
      if (name === "get_addresses") {
        result = {
          addresses: [
            { id: "addr-home", addressLine: "Test: 1 Main Road", addressTag: "Home" },
            { id: "addr-work", addressLine: "Test: 2 Work Road", addressTag: "Work" },
          ],
        }
      } else if (name === "search_restaurants") {
        result = {
          restaurants: [
            { id: "r1", name: "Test Kitchen", availabilityStatus: "OPEN", distanceKm: 2, deliveryTimeMinutes: 30 },
          ],
        }
      } else if (name === "search_menu") {
        const items =
          String(args.query).toLowerCase().includes("pizza")
            ? [
                {
                  menu_item_id: "m3",
                  name: "Margherita Pizza",
                  price: 109,
                  isVeg: true,
                  hasVariants: true,
                  variantsV2: [
                    {
                      groupId: "crust",
                      name: "Crust",
                      variations: [
                        { name: "New Hand Tossed", id: "c1", inStock: 1, default: 1 },
                        { name: "Cheese Burst", id: "c2", inStock: 1 },
                      ],
                    },
                    {
                      groupId: "size",
                      name: "Size",
                      variations: [
                        { name: "Regular", id: "s1", inStock: 1, default: 1 },
                        { name: "Medium", id: "s2", inStock: 1 },
                      ],
                    },
                  ],
                },
              ]
            : String(args.query).toLowerCase().includes("chow")
            ? [
                {
                  menu_item_id: "m1",
                  name: "Veg Chow Mein",
                  price: 150,
                  isVeg: true,
                  hasVariants: true,
                  variantsV2: [
                    {
                      groupId: "g1",
                      name: "Quantity",
                      variations: [
                        { name: "Half", price: 150, id: "v1", inStock: 1, default: 1 },
                        { name: "Full", price: 200, id: "v2", inStock: 1 },
                      ],
                    },
                  ],
                },
              ]
            : [{ menu_item_id: "m2", name: "Spring Roll", price: 180, isVeg: true }]
        result = { items }
      } else if (name === "get_food_cart") {
        result = { statusCode: 0, data: state.cart }
      } else if (name === "update_food_cart") {
        const items = args.cartItems.map((entry: any) => {
          const base = itemFor(entry.menu_item_id, entry.menu_item_id === "m1" ? "Veg Chow Mein" : "Spring Roll")
          const variant = entry.variantsV2?.[0] ?? entry.variations?.[0]
          const unit = variant?.variation_id === "v2" ? 200 : base.price
          return {
            menu_item_id: entry.menu_item_id,
            name: base.name,
            quantity: entry.quantity,
            final_price: unit,
            subtotal: unit * entry.quantity,
            variants: variant ? [{ variation_id: variant.variation_id, name: variant.variation_id === "v2" ? "Full" : "Half" }] : [],
          }
        })
        const itemTotal = items.reduce((sum: number, item: any) => sum + item.subtotal, 0)
        const taxes = Math.round(itemTotal * 0.1 * 100) / 100
        state.cart = { items, pricing: { item_total: itemTotal, delivery_charge: 0, taxes_and_charges: taxes, to_pay: itemTotal + taxes } }
        result = { statusCode: 0, data: state.cart }
      } else if (name === "flush_food_cart") {
        state.cart = null
        result = { statusCode: 0, statusMessage: "CART_DELETED_SUCCESSFULLY" }
      } else if (name === "fetch_food_coupons") {
        result = {
          coupon_sections: [
            { coupons: [{ coupon_code: "SAVE50", description: "₹50 off", discount: 50, applicable: true }] },
          ],
        }
      } else {
        result = {}
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result },
        }),
      )
    })
  })
  return new Promise<{ url: string; calls: any[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/food`,
        calls,
        close: () => server.close(),
      })
    })
  })
}

function account(): Account {
  return {
    id: "swiggy:test",
    provider: "swiggy",
    label: "Test",
    tokens: { accessToken: "token", refreshToken: "refresh", expiresAt: nowSec() + 3600 },
    addedAt: new Date().toISOString(),
  }
}

async function withMock(
  state: CartState,
  run: (mock: { url: string; calls: any[] }) => Promise<void>,
): Promise<void> {
  const mock = await mockSwiggy(state)
  process.env.FOODCOMPARE_SWIGGY_MCP_URL = mock.url
  try {
    await run(mock)
  } finally {
    delete process.env.FOODCOMPARE_SWIGGY_MCP_URL
    mock.close()
  }
}

test("exact quote reads a real cart, maps totals, and flushes", async () => {
  const state: CartState = { cart: null }
  await withMock(state, async (mock) => {
    const quote = await swiggyQuote(account(), {
      address: "Home",
      restaurant: "Test Kitchen",
      items: [{ name: "Veg Chow Mein", variant: "Full", qty: 2 }],
      estimate: false,
    })
    assert.equal(quote.estimate, false)
    assert.equal(quote.lines[0].unitPrice, 200)
    assert.equal(quote.lines[0].qty, 2)
    assert.equal(quote.pricing.itemTotal, 400)
    assert.equal(quote.pricing.toPay, 440)
    assert.equal(quote.coupons[0].code, "SAVE50")
    const update = mock.calls.find((call) => call.name === "update_food_cart")
    assert.deepEqual(update.args.cartItems, [
      { menu_item_id: "m1", quantity: 2, variantsV2: [{ group_id: "g1", variation_id: "v2" }] },
    ])
    assert.equal(state.cart, null)
    assert.equal(mock.calls.filter((call) => call.name === "flush_food_cart").length, 1)
  })
})

test("exact quote aborts on a non-empty cart unless --replace-cart", async () => {
  const state: CartState = { cart: { items: [{ menu_item_id: 1, name: "Old", quantity: 1, subtotal: 10 }], pricing: {} } }
  await withMock(state, async (mock) => {
    await assert.rejects(
      () =>
        swiggyQuote(account(), {
          address: "Home",
          restaurant: "Test Kitchen",
          items: [{ name: "Spring Roll", qty: 1 }],
          estimate: false,
        }),
      (error: unknown) => error instanceof UserError && /not empty/.test(error.message),
    )
    assert.equal(mock.calls.some((call) => call.name === "update_food_cart"), false)
    assert.equal(state.cart.items[0].name, "Old")

    const quote = await swiggyQuote(account(), {
      address: "Home",
      restaurant: "Test Kitchen",
      items: [{ name: "Spring Roll", qty: 1 }],
      estimate: false,
      replaceCart: true,
    })
    assert.equal(quote.pricing.itemTotal, 180)
    assert.equal(state.cart, null)
  })
})

test("estimate quote never writes to the cart", async () => {
  const state: CartState = { cart: null }
  await withMock(state, async (mock) => {
    const quote = await swiggyQuote(account(), {
      address: "Work",
      restaurant: "Test Kitchen",
      items: [{ name: "Veg Chow Mein", variant: "Full", qty: 2 }],
      estimate: true,
    })
    assert.equal(quote.pricing.itemTotal, 400)
    assert.equal(quote.pricing.delivery, null)
    assert.equal(quote.pricing.toPay, null)
    assert.ok(quote.warnings.some((warning) => warning.includes("Estimate only")))
    assert.equal(mock.calls.some((call) => call.name === "update_food_cart"), false)
    assert.equal(mock.calls.some((call) => call.name === "flush_food_cart"), false)
  })
})

test("estimate falls back to the base price when Swiggy hides variant prices", async () => {
  const state: CartState = { cart: null }
  await withMock(state, async (mock) => {
    const quote = await swiggyQuote(account(), {
      address: "Home",
      restaurant: "Test Kitchen",
      items: [{ name: "Margherita Pizza", variant: "Medium", qty: 2 }],
      estimate: true,
    })
    assert.equal(quote.lines[0].unitPrice, 109)
    assert.equal(quote.lines[0].variant, "New Hand Tossed · Medium")
    assert.equal(quote.pricing.itemTotal, 218)
    assert.ok(quote.warnings.some((warning) => warning.includes("base price")))
    assert.equal(mock.calls.some((call) => call.name === "update_food_cart"), false)
  })
})
