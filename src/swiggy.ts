import type {
  Account,
  Address,
  Coupon,
  ItemRequest,
  Pricing,
  Quote,
  QuoteLine,
  QuoteRequest,
  Store,
  Variant,
} from "./core.ts"
import { UserError, bestMatch, collectCoupons, formatINR, normalize, nowSec, resolveAddress } from "./core.ts"
import { McpClient } from "./mcp.ts"
import { PROVIDERS, ensureFresh, refreshAccount } from "./auth.ts"

const ALLOWED = [
  "get_addresses",
  "search_restaurants",
  "search_menu",
  "get_restaurant_menu",
  "get_food_cart",
  "update_food_cart",
  "flush_food_cart",
  "fetch_food_coupons",
  "apply_food_coupon",
]

type RawVariant = Variant & {
  format: "v2" | "legacy"
  groupId: string | number
  groupName: string
  id: string | number
  inStock: boolean
  default: boolean
  priceKnown: boolean
}

type RawItem = {
  id: string
  name: string
  price: number
  veg?: boolean
  variants: RawVariant[]
}

type Match = { item: RawItem; variants: RawVariant[] }

export function swiggyClient(account: Account, store?: Store): McpClient {
  const save = () => store?.upsert(account)
  return new McpClient({
    url: process.env.FOODCOMPARE_SWIGGY_MCP_URL || PROVIDERS.swiggy.mcpUrl,
    allowTools: ALLOWED,
    getToken: async () => {
      if (account.tokens.expiresAt - nowSec() <= 120) {
        await ensureFresh(account)
        save()
      }
      return account.tokens.accessToken
    },
    refresh: async () => {
      await refreshAccount("swiggy", account)
      save()
    },
  })
}

function number(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function mapAddress(raw: any): Address {
  return {
    id: String(raw.id ?? raw.addressId ?? ""),
    line: String(raw.addressLine ?? raw.address ?? raw.line ?? ""),
    tag: raw.addressTag ?? raw.tag ?? undefined,
    category: raw.addressCategory ?? raw.category ?? undefined,
    phone: raw.phoneNumber ?? raw.phone ?? undefined,
  }
}

export async function swiggyAddresses(account: Account, store?: Store): Promise<Address[]> {
  const { data } = await swiggyClient(account, store).callTool("get_addresses", {})
  const raw = data?.addresses ?? []
  return raw.map(mapAddress).filter((address: Address) => address.id)
}

function variantsOf(raw: any): RawVariant[] {
  const groups = Array.isArray(raw.variantsV2) && raw.variantsV2.length > 0 ? { list: raw.variantsV2, format: "v2" as const } : null
  const legacy = Array.isArray(raw.variations) && raw.variations.length > 0 ? { list: raw.variations, format: "legacy" as const } : null
  const chosen = groups ?? legacy
  if (!chosen) return []
  const result: RawVariant[] = []
  for (const group of chosen.list) {
    const groupId = group.groupId ?? group.group_id
    for (const variation of group.variations ?? []) {
      const rawPrice = variation.price
      const priceKnown = rawPrice !== undefined && rawPrice !== null && Number.isFinite(Number(rawPrice))
      result.push({
        groupId,
        groupName: String(group.name ?? group.groupName ?? ""),
        id: variation.id ?? variation.variation_id,
        name: String(variation.name ?? variation.variation_name ?? ""),
        price: number(rawPrice),
        inStock: variation.inStock !== 0,
        default: variation.default === 1 || variation.default === true,
        format: chosen.format,
        priceKnown,
      })
    }
  }
  return result
}

function mapItem(raw: any): RawItem {
  return {
    id: String(raw.menu_item_id ?? raw.id ?? ""),
    name: String(raw.name ?? ""),
    price: number(raw.price),
    veg: raw.isVeg === true || raw.isVeg === 1 || raw.veg === true,
    variants: variantsOf(raw),
  }
}

function chooseVariants(item: RawItem, requested?: string): RawVariant[] {
  if (item.variants.length === 0) {
    if (requested) throw new UserError(`"${item.name}" has no variants; remove ":${requested}".`)
    return []
  }
  const groups = new Map<string, RawVariant[]>()
  for (const variant of item.variants) {
    const key = String(variant.groupId)
    const group = groups.get(key) ?? []
    group.push(variant)
    groups.set(key, group)
  }
  const selected = new Map<string, RawVariant>()
  const inStockByGroup = new Map<string, RawVariant[]>()
  for (const [key, group] of groups) {
    const inStock = group.filter((variant) => variant.inStock)
    if (inStock.length === 0) throw new UserError(`"${item.name}" is out of stock.`)
    inStockByGroup.set(key, inStock)
  }
  const tokens = String(requested ?? "")
    .split(/\s*[/+]\s*/)
    .map((token) => token.trim())
    .filter(Boolean)
  for (const token of tokens) {
    let matched = false
    for (const [key, inStock] of inStockByGroup) {
      if (selected.has(key)) continue
      const match = bestMatch(token, inStock, (variant) => variant.name)
      if (match) {
        selected.set(key, match)
        matched = true
        break
      }
    }
    if (!matched) {
      const options = [...inStockByGroup.entries()]
        .map(([, group]) => {
          const name = group[0]?.groupName
          return `  ${name ? `${name}: ` : ""}${group.map((v) => v.name).join(", ")}`
        })
        .join("\n")
      throw new UserError(`No "${token}" variant for "${item.name}". Options:\n${options}`)
    }
  }
  return [...inStockByGroup.entries()].map(
    ([key, inStock]) => selected.get(key) ?? inStock.find((variant) => variant.default) ?? inStock[0],
  )
}

async function resolveRestaurant(
  client: McpClient,
  request: QuoteRequest,
  addressId: string,
): Promise<{ id: string; name: string; etaMinutes?: number; distanceKm?: number }> {
  if (request.restaurantId && !request.restaurant) {
    try {
      const { data } = await client.callTool("get_restaurant_menu", {
        restaurantId: request.restaurantId,
        addressId,
      })
      const restaurant = data?.restaurant ?? data?.data?.restaurant ?? {}
      return {
        id: request.restaurantId,
        name: String(restaurant.name ?? data?.name ?? `Restaurant ${request.restaurantId}`),
        etaMinutes: number(restaurant.deliveryTimeMinutes ?? restaurant.etaMinutes, NaN) || undefined,
        distanceKm: number(restaurant.distanceKm, NaN) || undefined,
      }
    } catch {
      return { id: request.restaurantId, name: `Restaurant ${request.restaurantId}` }
    }
  }
  if (!request.restaurant) throw new UserError("Provide --restaurant (or --restaurant-id).")
  const query = request.restaurant
  const { data } = await client.callTool("search_restaurants", { query, addressId })
  const restaurants = (data?.restaurants ?? []) as any[]
  if (restaurants.length === 0) throw new UserError(`No restaurants found for "${query}".`)
  const open = restaurants.filter((restaurant) => restaurant.availabilityStatus === "OPEN")
  const match =
    (request.restaurantId && restaurants.find((restaurant) => String(restaurant.id) === request.restaurantId)) ||
    bestMatch(query, open, (restaurant) => String(restaurant.name))
  if (!match) {
    const closed = restaurants.find((restaurant) => matchScoreName(query, restaurant.name))
    if (closed) throw new UserError(`${closed.name} is ${closed.availabilityStatus ?? "unavailable"} right now.`)
    throw new UserError(
      `No open restaurant matches "${query}". Nearby results:\n` +
        restaurants.map((restaurant) => `  - ${restaurant.name} (${restaurant.availabilityStatus})`).join("\n"),
    )
  }
  return {
    id: String(match.id),
    name: String(match.name),
    etaMinutes: number(match.deliveryTimeMinutes, NaN) || undefined,
    distanceKm: number(match.distanceKm, NaN) || undefined,
  }
}

function matchScoreName(query: string, name: string): boolean {
  return normalize(query) === normalize(name) || normalize(name).includes(normalize(query))
}

async function resolveItem(
  client: McpClient,
  restaurantId: string,
  addressId: string,
  request: ItemRequest,
): Promise<Match> {
  const { data } = await client.callTool("search_menu", {
    query: request.name,
    addressId,
    restaurantIdOfAddedItem: restaurantId,
  })
  const items = ((data?.items ?? []) as any[]).map(mapItem).filter((item) => item.id)
  if (items.length === 0) throw new UserError(`No menu items found for "${request.name}".`)
  const item = bestMatch(request.name, items, (candidate) => candidate.name)
  if (!item) {
    throw new UserError(
      `No dish matches "${request.name}". Closest results:\n` +
        items.slice(0, 8).map((candidate) => `  - ${candidate.name} ${formatINR(candidate.price)}`).join("\n"),
    )
  }
  return { item, variants: chooseVariants(item, request.variant) }
}

function cartItemPayload(match: Match, quantity: number) {
  const payload: Record<string, unknown> = { menu_item_id: match.item.id, quantity }
  if (match.variants.length > 0) {
    const pairs = match.variants.map((variant) => ({
      group_id: variant.groupId,
      variation_id: variant.id,
    }))
    if (match.variants[0].format === "v2") payload.variantsV2 = pairs
    else payload.variations = pairs
  }
  return payload
}

async function readCart(client: McpClient, addressId: string, restaurantName: string): Promise<any> {
  const { data } = await client.callTool("get_food_cart", { addressId, restaurantName })
  if (data && typeof data === "object" && "data" in data) return data.data
  return data
}

function hasItems(cart: any): boolean {
  return Boolean(cart && Array.isArray(cart.items) && cart.items.length > 0)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function flushCart(client: McpClient, addressId: string, restaurantName: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    await client.callTool("flush_food_cart", {})
    await sleep(400)
    if (!hasItems(await readCart(client, addressId, restaurantName))) return
  }
  throw new UserError("Could not empty the Swiggy cart after two attempts.")
}

async function fetchCoupons(client: McpClient, restaurantId: string, addressId: string): Promise<Coupon[]> {
  try {
    const { data } = await client.callTool("fetch_food_coupons", { restaurantId, addressId })
    return collectCoupons(data).slice(0, 20)
  } catch {
    return []
  }
}

function mapLines(cart: any): QuoteLine[] {
  return (cart.items ?? []).map((item: any) => {
    const quantity = number(item.quantity, 1)
    const unitPrice = number(item.final_price ?? item.total ?? item.subtotal)
    return {
      name: String(item.name ?? "Item"),
      variant: item.variants?.[0]?.name ? String(item.variants[0].name) : undefined,
      qty: quantity,
      unitPrice,
      lineTotal: number(item.subtotal, unitPrice * quantity),
    }
  })
}

function mapPricing(cart: any): Pricing {
  const pricing = cart?.pricing ?? {}
  const itemTotal = number(pricing.item_total, NaN)
  const delivery = number(pricing.delivery_charge, NaN)
  const taxes = number(pricing.taxes_and_charges, NaN)
  const discount = number(cart?.offers?.coupon_discount, NaN)
  const toPay = number(pricing.to_pay, NaN)
  return {
    itemTotal: Number.isFinite(itemTotal) ? itemTotal : null,
    delivery: Number.isFinite(delivery) ? delivery : null,
    taxes: Number.isFinite(taxes) ? taxes : null,
    discount: Number.isFinite(discount) ? discount : null,
    toPay: Number.isFinite(toPay) ? toPay : null,
  }
}

export async function swiggyQuote(account: Account, request: QuoteRequest, store?: Store): Promise<Quote> {
  const client = swiggyClient(account, store)
  const addresses = await swiggyAddresses(account, store)
  const address = resolveAddress(addresses, request.address)
  const restaurant = await resolveRestaurant(client, request, address.id)
  const matches: Match[] = []
  for (const item of request.items) {
    matches.push(await resolveItem(client, restaurant.id, address.id, item))
  }
  const warnings: string[] = []
  const estimate = request.estimate !== false
  let lines: QuoteLine[]
  let pricing: Pricing
  let coupons: Coupon[]
  let flushError: string | undefined

  if (estimate) {
    lines = matches.map((match, index) => {
      const quantity = request.items[index]?.qty ?? 1
      const singleKnown =
        match.variants.length === 1 && match.variants[0].priceKnown ? match.variants[0] : undefined
      const unitPrice = singleKnown ? singleKnown.price : match.item.price
      if (match.variants.length > 1 || match.variants.some((variant) => !variant.priceKnown)) {
        warnings.push(
          `Swiggy does not expose a combined price for the selected "${match.item.name}" options; estimate uses its base price. Use --exact for the variant price.`,
        )
      }
      return {
        name: match.item.name,
        variant: match.variants.map((variant) => variant.name).filter(Boolean).join(" · ") || undefined,
        qty: quantity,
        unitPrice,
        lineTotal: unitPrice * quantity,
      }
    })
    pricing = {
      itemTotal: lines.reduce((sum, line) => sum + line.lineTotal, 0),
      delivery: null,
      taxes: null,
      discount: null,
      toPay: null,
    }
    coupons = await fetchCoupons(client, restaurant.id, address.id)
    warnings.push("Estimate only: delivery fee, taxes and coupon savings are not included. Use --exact for the final amount.")
  } else {
    const existing = await readCart(client, address.id, restaurant.name)
    if (hasItems(existing)) {
      if (!request.replaceCart) {
        throw new UserError(
          `The Swiggy cart for "${account.label}" is not empty. Use --estimate, or --replace-cart to clear it.`,
        )
      }
      await flushCart(client, address.id, restaurant.name)
    }
    try {
      await client.callTool("update_food_cart", {
        restaurantId: restaurant.id,
        restaurantName: restaurant.name,
        addressId: address.id,
        cartItems: matches.map((match, index) => cartItemPayload(match, request.items[index]?.qty ?? 1)),
      })
      let cart = await readCart(client, address.id, restaurant.name)
      if (!hasItems(cart)) throw new UserError("Swiggy returned an empty cart after adding items.")
      coupons = await fetchCoupons(client, restaurant.id, address.id)
      if (request.applyBestCoupon) {
        const candidate = coupons.find((coupon) => coupon.code && coupon.applicable !== false)
        if (!candidate?.code) {
          warnings.push("No applicable coupon code was available to apply.")
        } else {
          await client.callTool("apply_food_coupon", { couponCode: candidate.code, addressId: address.id })
          cart = await readCart(client, address.id, restaurant.name)
        }
      }
      lines = mapLines(cart)
      pricing = mapPricing(cart)
    } finally {
      try {
        await flushCart(client, address.id, restaurant.name)
      } catch (error) {
        flushError = (error as Error).message
      }
    }
    if (flushError) warnings.push(`Could not verify cart cleanup: ${flushError}`)
  }

  return {
    provider: "swiggy",
    accountId: account.id,
    accountLabel: account.label,
    restaurant,
    address,
    lines,
    pricing,
    coupons,
    warnings,
    estimate,
  }
}
