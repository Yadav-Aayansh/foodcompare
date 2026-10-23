import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { zomatoClient, zomatoQuote } from "../src/zomato.ts"
import type { Account } from "../src/core.ts"
import { UserError, nowSec } from "../src/core.ts"

function mockZomato() {
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
      if (name === "get_saved_addresses_for_user") {
        result = {
          result: {
            addresses: [
              { address_id: "123", location_name: "1 Test Road, Test City" },
              { address_id: "456", location_name: "2 Work Road, Test City" },
            ],
            success: true,
          },
        }
      } else if (name === "get_restaurants_for_keyword") {
        result = {
          results: [
            {
              res_id: 67831,
              name: "Test Zomato Kitchen",
              distance: 2.5,
              eta: "30–35 min",
              res_offer: "Flat ₹50 OFF",
              serviceability_status: "serviceable",
            },
          ],
        }
      } else if (name === "get_menu_items_listing") {
        result = {
          result: {
            data: {
              res_id: 67831,
              restaurant_name: "Test Zomato Kitchen",
              item_mappings: [
                { item_name: "Veg Chow Mein", categories: ["Chinese"], variant_id: "v_half", has_more_variants: true },
                { item_name: "Spring Roll", categories: ["Chinese"], variant_id: "v_roll", has_more_variants: false },
              ],
            },
          },
        }
      } else if (name === "get_restaurant_menu_by_categories") {
        result = {
          result: {
            data: {
              res_id: 67831,
              restaurant_name: "Test Zomato Kitchen",
              menu_items: [
                {
                  item_id: "ctl_1",
                  name: "Veg Chow Mein",
                  price: 150,
                  discounted_price: null,
                  variant_id: "v_half",
                  available_add_ons: null,
                  in_stock: true,
                  variants: [
                    {
                      variant_id: "v_half",
                      property_values: { Size: "Half", Crust: "Classic" },
                      price: 150,
                      discounted_price: null,
                      available_add_ons: null,
                      in_stock: true,
                    },
                    {
                      variant_id: "v_full",
                      property_values: { Size: "Full", Crust: "Classic" },
                      price: 200,
                      discounted_price: null,
                      available_add_ons: ["mg_1"],
                      in_stock: true,
                    },
                  ],
                },
                {
                  item_id: "ctl_2",
                  name: "Spring Roll",
                  price: 180,
                  discounted_price: null,
                  variant_id: "v_roll",
                  available_add_ons: null,
                  in_stock: true,
                  variants: null,
                },
              ],
            },
          },
        }
      } else if (name === "create_cart") {
        result = {
          success: true,
          message: "Cart created successfully.",
          cart: {
            cart_id: "cart-1",
            items: [
              {
                item: {
                  item_id: "ctl_1",
                  name: "Veg Chow Mein",
                  price: 200,
                  discounted_price: 200,
                  variants: [
                    {
                      variant_id: "v_full",
                      property_values: { Size: "Full", Crust: "Classic" },
                      price: 200,
                      discounted_price: null,
                      in_stock: true,
                    },
                  ],
                },
                quantity: 2,
                add_ons: [],
              },
              {
                item: {
                  item_id: "ctl_2",
                  name: "Spring Roll",
                  price: 180,
                  discounted_price: 180,
                  variant_id: "v_roll",
                },
                quantity: 1,
                add_ons: [],
              },
            ],
            charge_breakdown: {
              base_charges: [
                {
                  amount: 10,
                  discount: null,
                  charge_type: "CHARGE_ID_PLATFORM",
                  taxes: [{ tax_amount: 1.5, tax_type: "TAX_ID_UNKNOWN" }],
                },
                {
                  amount: 5,
                  discount: null,
                  charge_type: "CHARGE_ID_RESTAURANT_PACKAGING_CHARGES",
                  taxes: [{ tax_amount: 0.5, tax_type: "TAX_ID_CATALOG_ITEM_CHARGE" }],
                },
                {
                  amount: 20,
                  discount: null,
                  charge_type: "CHARGE_ID_DELIVERY_CHARGE",
                  taxes: [{ tax_amount: 1, tax_type: "TAX_ID_DELIVERY_CHARGE" }],
                },
              ],
              taxes: [{ tax_amount: 46.98, tax_type: "TAX_ID_CART" }],
            },
            item_total: 580,
            final_amount: 608.98,
            promo_code: "TEST50",
            promo_discount_amount: 50,
            payment_method_type: "upi",
            restaurant_name: "Test Zomato Kitchen",
          },
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
      resolve({ url: `http://127.0.0.1:${port}/mcp`, calls, close: () => server.close() })
    })
  })
}

function account(): Account {
  return {
    id: "zomato:test",
    provider: "zomato",
    label: "Test",
    tokens: { accessToken: "token", refreshToken: "refresh", expiresAt: nowSec() + 3600 },
    addedAt: new Date().toISOString(),
  }
}

async function withMock(run: (mock: { url: string; calls: any[] }) => Promise<void>): Promise<void> {
  const mock = await mockZomato()
  process.env.FOODCOMPARE_ZOMATO_MCP_URL = mock.url
  try {
    await run(mock)
  } finally {
    delete process.env.FOODCOMPARE_ZOMATO_MCP_URL
    mock.close()
  }
}

test("zomato exact quote creates one cart and maps charges", async () => {
  await withMock(async (mock) => {
    const quote = await zomatoQuote(account(), {
      address: "123",
      restaurant: "Test Zomato Kitchen",
      items: [
        { name: "Veg Chow Mein", variant: "Full", qty: 2 },
        { name: "Spring Roll", qty: 1 },
      ],
      estimate: false,
    })
    assert.equal(quote.address.id, "123")
    assert.equal(quote.restaurant.id, "67831")
    assert.equal(quote.restaurant.etaMinutes, 30)
    assert.equal(quote.restaurant.distanceKm, 2.5)
    assert.equal(quote.lines.length, 2)
    assert.equal(quote.lines[0].variant, "Full · Classic")
    assert.equal(quote.lines[0].unitPrice, 200)
    assert.equal(quote.lines[1].unitPrice, 180)
    assert.equal(quote.pricing.itemTotal, 580)
    assert.equal(quote.pricing.delivery, 20)
    assert.equal(quote.pricing.fees, 15)
    assert.equal(quote.pricing.taxes, 43.98)
    assert.equal(quote.pricing.discount, 50)
    assert.equal(quote.pricing.toPay, 608.98)
    assert.equal(quote.coupons[0].code, "TEST50")
    assert.equal(quote.coupons[0].applied, true)
    assert.ok(quote.warnings.some((warning) => warning.includes("auto-applied TEST50")))
    assert.ok(quote.warnings.some((warning) => warning.includes("payment method: upi")))
    assert.ok(quote.warnings.some((warning) => warning.includes("cart-1")))
    assert.ok(quote.warnings.some((warning) => warning.includes("does not expose additional checkout coupons")))
    const listing = mock.calls.find((call) => call.name === "get_menu_items_listing")
    assert.deepEqual(listing.args, { res_id: 67831, address_id: "123" })
    const menu = mock.calls.find((call) => call.name === "get_restaurant_menu_by_categories")
    assert.deepEqual(menu.args, { res_id: 67831, address_id: "123", categories: ["Chinese"] })
    const cart = mock.calls.find((call) => call.name === "create_cart")
    assert.deepEqual(cart.args, {
      res_id: 67831,
      address_id: "123",
      payment_type: "upi",
      items: [
        { variant_id: "v_full", quantity: 2 },
        { variant_id: "v_roll", quantity: 1 },
      ],
    })
    assert.equal(mock.calls.some((call) => call.name === "get_cart_offers"), false)
    assert.equal(mock.calls.some((call) => call.name === "checkout_cart"), false)
  })
})

test("zomato estimate never creates a cart", async () => {
  await withMock(async (mock) => {
    const quote = await zomatoQuote(account(), {
      address: "456",
      restaurant: "Test Zomato Kitchen",
      items: [{ name: "Veg Chow Mein", variant: "Full", qty: 2 }],
      estimate: true,
    })
    assert.equal(quote.lines[0].variant, "Full · Classic")
    assert.equal(quote.pricing.itemTotal, 400)
    assert.equal(quote.pricing.toPay, null)
    assert.equal(mock.calls.some((call) => call.name === "create_cart"), false)
  })
})

test("zomato client refuses checkout and phone binding", async () => {
  await withMock(async () => {
    const client = zomatoClient(account())
    await assert.rejects(() => client.callTool("checkout_cart", {}), UserError)
    await assert.rejects(() => client.callTool("bind_user_number", {}), UserError)
  })
})
