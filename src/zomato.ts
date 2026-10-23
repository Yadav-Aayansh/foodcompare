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
} from "./core.ts"
import { UserError, bestMatch, formatINR, resolveAddress, nowSec } from "./core.ts"
import { McpClient } from "./mcp.ts"
import { PROVIDERS, ensureFresh, refreshAccount } from "./auth.ts"

export const ZOMATO_TOOLS = [
  "create_cart",
  "checkout_cart",
  "get_saved_addresses_for_user",
  "get_restaurant_menu_by_categories",
  "get_menu_items_listing",
  "get_order_history",
  "get_order_tracking_info",
  "get_restaurants_for_keyword",
  "bind_user_number",
  "bind_user_number_verify_code",
]

const ALLOWED = [
  "get_saved_addresses_for_user",
  "get_restaurants_for_keyword",
  "get_restaurant_menu_by_categories",
  "get_menu_items_listing",
  "create_cart",
]

type RawVariant = {
  id: string
  name: string
  price: number
  default: boolean
}

type RawItem = {
  id: string
  name: string
  price: number
  variants: RawVariant[]
  hasModifiers: boolean
  requiredModifiers?: boolean
}

export function zomatoClient(account: Account, store?: Store): McpClient {
  const save = () => store?.upsert(account)
  return new McpClient({
    url: process.env.FOODCOMPARE_ZOMATO_MCP_URL || PROVIDERS.zomato.mcpUrl,
    allowTools: ALLOWED,
    getToken: async () => {
      if (account.tokens.expiresAt - nowSec() <= 120) {
        await ensureFresh(account)
        save()
      }
      return account.tokens.accessToken
    },
    refresh: async () => {
      await refreshAccount("zomato", account)
      save()
    },
  })
}

function* walk(node: unknown, depth = 0): Generator<Record<string, any>> {
  if (!node || typeof node !== "object" || depth > 12) return
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child, depth + 1)
    return
  }
  yield node as Record<string, any>
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") yield* walk(value, depth + 1)
  }
}

function text(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number") return String(value)
  }
  return undefined
}

function money(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN
  if (typeof value === "string") {
    const match = value.replace(/,/g, "").match(/-?\d+(\.\d+)?/)
    return match ? Number(match[0]) : NaN
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return money(record.amount ?? record.value ?? record.price ?? record.final_price)
  }
  return NaN
}

function arrayUnder(data: unknown, keys: string[]): any[] | undefined {
  const wanted = new Set(keys.map((key) => key.toLowerCase()))
  for (const record of walk(data)) {
    for (const [key, value] of Object.entries(record)) {
      if (wanted.has(key.toLowerCase()) && Array.isArray(value)) return value
    }
  }
  return undefined
}

function someNumber(records: Record<string, any>[], keys: string[]): number {
  for (const key of keys) {
    for (const record of records) {
      const value = money(record[key])
      if (Number.isFinite(value)) return value
    }
  }
  return NaN
}

function mapAddress(raw: Record<string, any>): Address | undefined {
  const id = text(raw.address_id, raw.addressId)
  if (!id) return undefined
  const nested = raw.address && typeof raw.address === "object" ? (raw.address as Record<string, any>) : {}
  const line =
    text(
      raw.formatted_address,
      raw.complete_address,
      raw.full_address,
      raw.address_line,
      raw.address,
      nested.formatted_address,
      nested.line,
      raw.location_name,
      raw.name,
    ) ?? ""
  return {
    id,
    line,
    tag: text(raw.address_tag, raw.tag, raw.label),
    category: text(raw.address_category, raw.category, raw.type),
    phone: text(raw.phone, raw.phone_number),
  }
}

export async function zomatoAddresses(account: Account, store?: Store): Promise<Address[]> {
  const { data } = await zomatoClient(account, store).callTool("get_saved_addresses_for_user", {})
  const addresses: Address[] = []
  const seen = new Set<string>()
  for (const record of walk(data)) {
    const address = mapAddress(record)
    if (address && !seen.has(address.id) && (address.line || address.tag)) {
      seen.add(address.id)
      addresses.push(address)
    }
  }
  if (addresses.length === 0) throw new UserError("Zomato returned no saved addresses.")
  return addresses
}

type ZomatoRestaurant = {
  id: string
  name: string
  etaMinutes?: number
  distanceKm?: number
  offer?: string
  serviceable?: boolean
}

function mapRestaurant(raw: Record<string, any>): ZomatoRestaurant | undefined {
  const id = text(raw.res_id, raw.restaurant_id, raw.resId)
  const name = text(raw.name, raw.restaurant_name, raw.title)
  if (!id || !name) return undefined
  if (raw.variant_id || raw.item_id || raw.category_name) return undefined
  const eta = money(raw.delivery_time_minutes ?? raw.delivery_time ?? raw.eta_minutes ?? raw.eta)
  const distance = money(raw.distance_km ?? raw.distance ?? raw.distance_in_km)
  const status = text(raw.serviceability_status, raw.serviceability, raw.status)
  return {
    id,
    name,
    etaMinutes: Number.isFinite(eta) && eta < 300 ? eta : undefined,
    distanceKm: Number.isFinite(distance) && distance < 100 ? distance : undefined,
    offer: text(raw.res_offer, raw.offer, raw.offer_text, raw.discount_text),
    serviceable: status ? status.toLowerCase() === "serviceable" : undefined,
  }
}

async function resolveRestaurant(
  client: McpClient,
  request: QuoteRequest,
  addressId: string,
): Promise<ZomatoRestaurant> {
  if (request.restaurantId && !request.restaurant) {
    return { id: request.restaurantId, name: `Restaurant ${request.restaurantId}` }
  }
  if (!request.restaurant) throw new UserError("Provide --restaurant (or --restaurant-id).")
  const query = request.restaurant
  const { data } = await client.callTool("get_restaurants_for_keyword", {
    address_id: addressId,
    keyword: query,
  })
  const candidates: ZomatoRestaurant[] = []
  const seen = new Set<string>()
  for (const record of walk(data)) {
    const restaurant = mapRestaurant(record)
    if (restaurant && !seen.has(restaurant.id)) {
      seen.add(restaurant.id)
      candidates.push(restaurant)
    }
  }
  if (candidates.length === 0) throw new UserError(`Zomato found no restaurants for "${query}".`)
  const serviceable = candidates.filter((candidate) => candidate.serviceable !== false)
  if (serviceable.length === 0) {
    throw new UserError(
      `Zomato cannot deliver any match for "${query}" to this address. Closest results:\n` +
        candidates
          .slice(0, 8)
          .map((candidate) => `  - ${candidate.name} (${candidate.serviceable === false ? "unserviceable" : "unknown"})`)
          .join("\n"),
    )
  }
  const match =
    (request.restaurantId && serviceable.find((candidate) => candidate.id === request.restaurantId)) ||
    bestMatch(query, serviceable, (candidate) => candidate.name)
  if (!match) {
    throw new UserError(
      `No serviceable Zomato restaurant matches "${query}". Nearby results:\n` +
        serviceable.slice(0, 8).map((candidate) => `  - ${candidate.name}`).join("\n"),
    )
  }
  return match
}

function variantLabel(entry: any, fallback: string): string {
  const properties = entry?.property_values
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const entries = Object.entries(properties).filter(([, value]) => typeof value === "string" && value.trim())
    entries.sort(([left], [right]) =>
      left.toLowerCase() === "size" ? -1 : right.toLowerCase() === "size" ? 1 : 0,
    )
    if (entries.length > 0) return entries.map(([, value]) => String(value).trim()).join(" · ")
  }
  return text(entry?.name, entry?.variant_name, entry?.title, entry?.portion, fallback) ?? fallback
}

function variantsOf(raw: Record<string, any>): RawVariant[] {
  const variants: RawVariant[] = []
  const push = (entry: any, fallbackName: string) => {
    if (!entry) return
    if (typeof entry === "string") {
      variants.push({ id: entry, name: fallbackName, price: money(raw.price), default: variants.length === 0 })
      return
    }
    if (typeof entry !== "object" || entry.in_stock === false) return
    const id = text(entry.variant_id, entry.variation_id, entry.id)
    if (!id) return
    variants.push({
      id,
      name: variantLabel(entry, fallbackName),
      price: money(entry.discounted_price ?? entry.price ?? entry.final_price ?? entry.amount ?? raw.price),
      default: entry.is_default === true || entry.default === true || entry.default === 1,
    })
  }
  const fallbackName = text(raw.name, raw.item_name, raw.dish_name) ?? "Regular"
  if (Array.isArray(raw.variants)) for (const variant of raw.variants) push(variant, fallbackName)
  if (Array.isArray(raw.variant_list)) for (const variant of raw.variant_list) push(variant, fallbackName)
  if (Array.isArray(raw.variant_groups)) {
    for (const group of raw.variant_groups) {
      for (const variant of group?.variants ?? group?.options ?? []) {
        push(variant, text(group?.name, fallbackName) ?? fallbackName)
      }
    }
  }
  if (variants.length === 0 && text(raw.variant_id)) push(raw, fallbackName)
  return variants
}

function hasAddons(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value)
}

function mapItem(raw: Record<string, any>): RawItem | undefined {
  if (raw.modifier_id || raw.addon_id || raw.group_id || raw.group_name) return undefined
  if (raw.in_stock === false) return undefined
  const name = text(raw.name, raw.item_name, raw.dish_name)
  if (!name) return undefined
  const variants = variantsOf(raw)
  const price = money(raw.discounted_price ?? raw.price ?? raw.final_price ?? variants[0]?.price)
  if (variants.length === 0 && !Number.isFinite(price)) return undefined
  const variantAddons =
    Array.isArray(raw.variants) && raw.variants.some((variant: any) => hasAddons(variant?.available_add_ons))
  return {
    id: text(raw.item_id, raw.menu_item_id, raw.id) ?? name,
    name,
    price: Number.isFinite(price) ? price : variants[0]?.price ?? 0,
    variants,
    hasModifiers:
      raw.is_modifier_required === true ||
      hasAddons(raw.available_add_ons) ||
      hasAddons(raw.addons) ||
      hasAddons(raw.add_ons) ||
      hasAddons(raw.modifier_groups) ||
      variantAddons,
    requiredModifiers: raw.is_modifier_required === true,
  }
}

const ITEM_ARRAY_KEYS = new Set(["items", "menu_items", "dishes", "products", "item_list"])

function itemRecords(node: unknown, output: Record<string, any>[] = [], depth = 0): Record<string, any>[] {
  if (!node || typeof node !== "object" || depth > 12) return output
  if (Array.isArray(node)) {
    for (const child of node) {
      if (child && typeof child === "object") {
        if (!Array.isArray(child) && text((child as any).variant_id)) output.push(child as Record<string, any>)
        else itemRecords(child, output, depth + 1)
      }
    }
    return output
  }
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      if (ITEM_ARRAY_KEYS.has(key.toLowerCase())) {
        for (const entry of value) {
          if (entry && typeof entry === "object" && !Array.isArray(entry)) output.push(entry as Record<string, any>)
        }
      } else {
        itemRecords(value, output, depth + 1)
      }
    } else if (value && typeof value === "object") {
      itemRecords(value, output, depth + 1)
    }
  }
  return output
}

function collectItems(data: unknown): RawItem[] {
  const items: RawItem[] = []
  const seen = new Set<string>()
  for (const record of itemRecords(data)) {
    const item = mapItem(record)
    if (!item) continue
    const key = `${item.id}|${item.name}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  return items
}

async function flexibleTool(
  client: McpClient,
  name: string,
  variants: Record<string, unknown>[],
): Promise<any> {
  let lastError: unknown
  for (const args of variants) {
    try {
      const { data } = await client.callTool(name, args)
      return data
    } catch (error) {
      lastError = error
      const message = (error as Error).message
      if (!/validation|unknown|unexpected|required|input|argument|schema/i.test(message)) throw error
    }
  }
  throw lastError
}

type MenuMapping = { name: string; categories: string[] }

function numericId(id: string): number | string {
  const value = Number(id)
  return Number.isInteger(value) ? value : id
}

function menuMappings(data: unknown): MenuMapping[] {
  const mappings: MenuMapping[] = []
  for (const record of arrayUnder(data, ["item_mappings", "item_mapping"]) ?? []) {
    if (!record || typeof record !== "object") continue
    const name = text(record.item_name, record.name, record.dish_name)
    if (!name) continue
    const categories = (Array.isArray(record.categories) ? record.categories : [])
      .map((category: unknown) => text(category))
      .filter((category: string | undefined): category is string => Boolean(category))
    mappings.push({ name, categories })
  }
  return mappings
}

async function loadMenu(
  client: McpClient,
  restaurantId: string,
  addressId: string,
  wanted: ItemRequest[],
): Promise<{ items: RawItem[]; warnings: string[] }> {
  const warnings: string[] = []
  const listing = await client.callTool("get_menu_items_listing", {
    res_id: numericId(restaurantId),
    address_id: addressId,
  })
  const mappings = menuMappings(listing.data)
  if (mappings.length === 0) throw new UserError("Zomato returned no readable menu listing for this restaurant.")

  const categories = new Set<string>()
  for (const request of wanted) {
    const match = bestMatch(request.name, mappings, (mapping) => mapping.name)
    if (!match) {
      throw new UserError(
        `No Zomato dish matches "${request.name}". Menu items include:\n` +
          mappings.slice(0, 15).map((mapping) => `  - ${mapping.name}`).join("\n"),
      )
    }
    if (match.categories.length === 0) {
      throw new UserError(`Zomato did not return a menu category for "${match.name}".`)
    }
    for (const category of match.categories) categories.add(category)
  }

  const menu = await client.callTool("get_restaurant_menu_by_categories", {
    res_id: numericId(restaurantId),
    address_id: addressId,
    categories: [...categories].slice(0, 25),
  })
  const items = collectItems(menu.data)
  if (items.length === 0) throw new UserError("Zomato returned no readable menu items for this restaurant.")
  return { items, warnings }
}

function chooseVariant(item: RawItem, requested?: string): RawVariant {
  if (item.variants.length === 0) {
    throw new UserError(`Zomato menu entry "${item.name}" has no variant_id, so it cannot be priced.`)
  }
  if (requested) {
    const match = bestMatch(requested, item.variants, (variant) => variant.name)
    if (!match) {
      throw new UserError(
        `No "${requested}" variant for "${item.name}". Options:\n` +
          item.variants.map((variant) => `  - ${variant.name} ${formatINR(variant.price)}`).join("\n"),
      )
    }
    return match
  }
  return item.variants.find((variant) => variant.default) ?? item.variants[0]
}

type Match = { item: RawItem; variant: RawVariant }

function quantityOf(request: ItemRequest): number {
  return Math.max(1, request.qty || 1)
}

function mapCartLines(cart: any, matches: Match[], requests: ItemRequest[]): QuoteLine[] {
  const rawItems = arrayUnder(cart, ["items", "cart_items", "order_items"]) ?? []
  const lines: QuoteLine[] = []
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue
    const item = raw.item && typeof raw.item === "object" ? raw.item : raw
    const quantity = money(raw.quantity ?? raw.qty ?? item.quantity ?? 1)
    if (!Number.isFinite(quantity) || quantity <= 0) continue
    const name = text(item.name, item.item_name, item.title)
    if (!name) continue
    const selected = Array.isArray(item.variants) ? item.variants[0] : undefined
    const variantName = selected
      ? variantLabel(selected, name)
      : text(raw.variant_name, raw.variation_name, raw.variant?.name)
    const unitPrice = selected
      ? money(selected.discounted_price ?? selected.price)
      : money(item.discounted_price ?? item.price ?? item.final_price)
    lines.push({
      name,
      variant: variantName,
      qty: quantity,
      unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
      lineTotal: Number.isFinite(unitPrice) ? unitPrice * quantity : 0,
    })
  }
  if (lines.length === 0) {
    matches.forEach((match, index) => {
      const qty = quantityOf(requests[index] ?? { name: match.item.name, qty: 1 })
      lines.push({
        name: match.item.name,
        variant: match.variant.name,
        qty,
        unitPrice: match.variant.price,
        lineTotal: match.variant.price * qty,
      })
    })
  }
  return lines
}

function chargeAmount(cart: any, ids: string[], names: string[]): number {
  const entries = arrayUnder(cart, ["charge_breakdown", "charges", "breakdown", "charges_breakdown"])
  if (!entries) return NaN
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const id = text(entry.id, entry.charge_id, entry.key, entry.type, entry.code) ?? ""
    const name = text(entry.name, entry.title, entry.display_name, entry.label) ?? ""
    const matchesId = ids.some((candidate) => id.toLowerCase().includes(candidate.toLowerCase()))
    const matchesName = names.some((candidate) => name.toLowerCase().includes(candidate.toLowerCase()))
    if (matchesId || matchesName) {
      const amount = money(entry.amount ?? entry.value ?? entry.price ?? entry.total)
      if (Number.isFinite(amount)) return amount
    }
  }
  return NaN
}

function chargeBreakdown(cart: any): { base: any[]; taxes: any[] } {
  for (const record of walk(cart)) {
    const value = record.charge_breakdown
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return {
        base: Array.isArray(value.base_charges) ? value.base_charges : [],
        taxes: Array.isArray(value.taxes) ? value.taxes : [],
      }
    }
  }
  return { base: [], taxes: [] }
}

function mapPricing(cart: any): Pricing {
  const records = [...walk(cart)]
  const roots = [cart, cart?.data, cart?.result, cart?.cart].filter(
    (record): record is Record<string, any> => Boolean(record) && typeof record === "object" && !Array.isArray(record),
  )
  const pick = (keys: string[]) => {
    const rootValue = someNumber(roots, keys)
    return Number.isFinite(rootValue) ? rootValue : someNumber(records, keys)
  }

  const itemTotal = pick(["item_total", "items_total", "subtotal", "sub_total"])
  let effectiveTotal = 0
  for (const raw of arrayUnder(cart, ["items", "cart_items", "order_items"]) ?? []) {
    const item = raw?.item && typeof raw.item === "object" ? raw.item : raw
    const quantity = money(raw?.quantity ?? raw?.qty ?? item?.quantity ?? 1)
    const selected = Array.isArray(item?.variants) ? item.variants[0] : undefined
    const unitPrice = selected
      ? money(selected.discounted_price ?? selected.price)
      : money(item?.discounted_price ?? item?.price)
    if (Number.isFinite(quantity) && quantity > 0 && Number.isFinite(unitPrice)) {
      effectiveTotal += unitPrice * quantity
    }
  }
  const lineDiscount =
    Number.isFinite(itemTotal) && effectiveTotal > 0 ? Math.max(0, itemTotal - effectiveTotal) : 0
  const promoDiscount = money(cart?.promo_discount_amount ?? cart?.promoDiscount)
  const discount = lineDiscount + (Number.isFinite(promoDiscount) ? promoDiscount : 0)

  const { base, taxes: taxEntries } = chargeBreakdown(cart)
  let delivery: number | undefined
  let fees = 0
  let baseTaxes = 0
  for (const entry of base) {
    if (!entry || typeof entry !== "object") continue
    const amount = money(entry.amount ?? entry.value ?? entry.price ?? entry.total)
    const type = (text(entry.charge_type, entry.id, entry.name) ?? "").toUpperCase()
    if (type.includes("DELIVERY")) {
      delivery = (delivery ?? 0) + (Number.isFinite(amount) ? amount : 0)
    } else if (Number.isFinite(amount)) {
      fees += amount
    }
    for (const tax of Array.isArray(entry.taxes) ? entry.taxes : []) {
      const taxAmount = money(tax?.tax_amount ?? tax?.amount)
      if (Number.isFinite(taxAmount)) baseTaxes += taxAmount
    }
  }
  if (delivery === undefined) delivery = chargeAmount(cart, ["DELIVERY"], ["delivery"])

  let taxes = NaN
  const cartTaxes = taxEntries.reduce((sum, entry) => {
    const amount = money(entry?.tax_amount ?? entry?.amount)
    return Number.isFinite(amount) ? sum + amount : sum
  }, 0)
  if (taxEntries.length > 0) taxes = Math.max(0, cartTaxes - baseTaxes)
  if (!Number.isFinite(taxes)) {
    taxes = pick(["taxes_and_charges", "taxes", "tax", "gst"])
    if (!Number.isFinite(taxes)) taxes = chargeAmount(cart, ["TAX", "GST"], ["tax", "gst"])
  }

  let toPay = pick([
    "final_amount",
    "finalAmount",
    "to_pay",
    "payable_amount",
    "payable",
    "amount_to_pay",
    "total_payable",
    "grand_total",
    "cart_total",
    "final_total",
    "total",
  ])
  if (!Number.isFinite(toPay)) {
    const parts = [effectiveTotal > 0 ? effectiveTotal : itemTotal, delivery, fees, taxes].filter((value) =>
      Number.isFinite(value),
    )
    if (parts.length > 0) {
      toPay = parts.reduce((sum, value) => sum + value, 0) - (Number.isFinite(promoDiscount) ? promoDiscount : 0)
    }
  }
  return {
    itemTotal: Number.isFinite(itemTotal) ? itemTotal : null,
    delivery: Number.isFinite(delivery) ? delivery : null,
    fees: base.length > 0 ? fees : null,
    taxes: Number.isFinite(taxes) ? taxes : null,
    discount: discount > 0 ? discount : null,
    toPay: Number.isFinite(toPay) ? toPay : null,
  }
}

function paymentCandidates(): string[] {
  return [process.env.FOODCOMPARE_ZOMATO_PAYMENT, "upi", "cash_on_delivery"].filter(
    (value): value is string => Boolean(value),
  )
}

async function createCart(
  client: McpClient,
  restaurantId: string,
  addressId: string,
  matches: Match[],
  requests: ItemRequest[],
): Promise<{ data: any; paymentType: string }> {
  const items = matches.map((match, index) => ({
    variant_id: match.variant.id,
    quantity: quantityOf(requests[index] ?? { name: match.item.name, qty: 1 }),
  }))
  let lastError: unknown
  for (const payment_type of [...new Set(paymentCandidates())]) {
    try {
      const { data } = await client.callTool("create_cart", {
        res_id: numericId(restaurantId),
        address_id: addressId,
        payment_type,
        items,
      })
      if (data?.success === false || data?.error) {
        throw new UserError(text(data.message, data.error, "Zomato rejected the cart.") ?? "Zomato rejected the cart.")
      }
      return { data, paymentType: payment_type }
    } catch (error) {
      lastError = error
      if (!/payment|validation|input|schema|rejected/i.test((error as Error).message)) throw error
    }
  }
  throw lastError
}

function findCartId(cart: any): string | undefined {
  for (const record of walk(cart)) {
    const id = text(record.cart_id, record.cartId)
    if (id) return id
  }
  for (const record of walk(cart)) {
    if (record.items || record.cart_items || record.charge_breakdown) {
      const id = text(record.id)
      if (id) return id
    }
  }
  return undefined
}

export async function zomatoQuote(account: Account, request: QuoteRequest, store?: Store): Promise<Quote> {
  const client = zomatoClient(account, store)
  const addresses = await zomatoAddresses(account, store)
  const address = resolveAddress(addresses, request.address)
  const restaurant = await resolveRestaurant(client, request, address.id)
  const { items: menu, warnings } = await loadMenu(client, restaurant.id, address.id, request.items)

  const matches: Match[] = []
  for (const wanted of request.items) {
    const item = bestMatch(wanted.name, menu, (candidate) => candidate.name)
    if (!item) {
      throw new UserError(
        `No Zomato dish matches "${wanted.name}". Closest results:\n` +
          menu.slice(0, 8).map((candidate) => `  - ${candidate.name}`).join("\n"),
      )
    }
    if (item.requiredModifiers) {
      warnings.push(`Zomato requires modifiers for "${item.name}"; defaults may be auto-filled and are not compared.`)
    } else if (item.hasModifiers) {
      warnings.push(`Zomato offers add-ons for "${item.name}"; optional add-ons are not selected.`)
    }
    matches.push({ item, variant: chooseVariant(item, wanted.variant) })
  }
  if (request.estimate) {
    const lines: QuoteLine[] = matches.map((match, index) => {
      const qty = quantityOf(request.items[index] ?? { name: match.item.name, qty: 1 })
      return {
        name: match.item.name,
        variant: match.variant.name,
        qty,
        unitPrice: match.variant.price,
        lineTotal: match.variant.price * qty,
      }
    })
    warnings.push("Zomato totals are before checkout offers; its MCP does not expose cart coupons.")
    if (restaurant.offer) warnings.push(`Restaurant offer "${restaurant.offer}" may apply at checkout; it is not included here.`)
    warnings.push("Estimate only: Zomato delivery, taxes and offers require create_cart. Use --exact for the quoted total.")
    return {
      provider: "zomato",
      accountId: account.id,
      accountLabel: account.label,
      restaurant,
      address,
      lines,
      pricing: {
        itemTotal: lines.reduce((sum, line) => sum + line.lineTotal, 0),
        delivery: null,
        fees: null,
        taxes: null,
        discount: null,
        toPay: null,
      },
      coupons: restaurant.offer ? [{ title: restaurant.offer }] : [],
      warnings,
      estimate: true,
    }
  }

  const created = await createCart(client, restaurant.id, address.id, matches, request.items)
  const cart = created.data.cart ?? created.data
  const lines = mapCartLines(cart, matches, request.items)
  const pricing = mapPricing(cart)
  if (pricing.toPay === null) warnings.push("Zomato did not return a payable total; it was assembled from the charge breakdown.")
  const promoCode = text(cart.promo_code, cart.promoCode)
  const promoDiscount = money(cart.promo_discount_amount ?? cart.promoDiscount)
  const appliedDiscount = Number.isFinite(promoDiscount) && promoDiscount > 0 ? promoDiscount : 0
  if (appliedDiscount > 0) {
    warnings.push(`Zomato auto-applied ${promoCode ?? "an offer"}: -${formatINR(appliedDiscount)}.`)
  } else if (restaurant.offer) {
    warnings.push(`Restaurant offer "${restaurant.offer}" may apply at checkout; it is not included here.`)
  }
  warnings.push("Zomato's MCP does not expose additional checkout coupons; the total includes any auto-applied offer.")
  warnings.push(`Zomato cart payment method: ${created.paymentType}.`)
  warnings.push(
    `Zomato has no cart-clear tool; cart ${findCartId(cart) ?? "(unknown)"} is left on the account.`,
  )
  const coupons: Coupon[] =
    appliedDiscount > 0
      ? [
          {
            code: promoCode,
            title: restaurant.offer ?? "Applied offer",
            discount: appliedDiscount,
            applied: true,
          },
        ]
      : restaurant.offer
        ? [{ title: restaurant.offer }]
        : []
  return {
    provider: "zomato",
    accountId: account.id,
    accountLabel: account.label,
    restaurant,
    address,
    lines,
    pricing,
    coupons,
    warnings,
    estimate: false,
  }
}
