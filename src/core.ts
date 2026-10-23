import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type ProviderId = "swiggy" | "zomato"

export type TokenSet = {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export type ClientInfo = {
  clientId?: string
  clientSecret?: string
  tokenEndpoint?: string
}

export type Account = {
  id: string
  provider: ProviderId
  label: string
  phone?: string
  tokens: TokenSet
  client?: ClientInfo
  addedAt: string
}

export type Address = {
  id: string
  line: string
  tag?: string
  category?: string
  phone?: string
}

export type Variant = {
  groupId: string
  id: string
  name: string
  price: number
}

export type MenuItem = {
  id: string
  name: string
  price: number
  veg?: boolean
  variants: Variant[]
}

export type ItemRequest = {
  name: string
  variant?: string
  qty: number
}

export type QuoteLine = {
  name: string
  variant?: string
  qty: number
  unitPrice: number
  lineTotal: number
}

export type Coupon = {
  code?: string
  title: string
  description?: string
  discount?: number
  applicable?: boolean
  applied?: boolean
}

export type Pricing = {
  itemTotal: number | null
  delivery: number | null
  fees?: number | null
  taxes: number | null
  discount: number | null
  toPay: number | null
}

export type Quote = {
  provider: ProviderId
  accountId: string
  accountLabel: string
  restaurant: { id: string; name: string; etaMinutes?: number; distanceKm?: number }
  address: Address
  lines: QuoteLine[]
  pricing: Pricing
  coupons: Coupon[]
  warnings: string[]
  estimate: boolean
}

export type QuoteRequest = {
  address: string
  restaurant?: string
  restaurantId?: string
  items: ItemRequest[]
  replaceCart?: boolean
  applyBestCoupon?: boolean
  estimate?: boolean
}

export class UserError extends Error {}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

export function configDir(): string {
  if (process.env.FOODCOMPARE_HOME) return process.env.FOODCOMPARE_HOME
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "foodcompare")
}

export function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

function tokens(value: string): string[] {
  return normalize(value).split(" ").filter(Boolean)
}

export function matchScore(query: string, candidate: string): number {
  const q = normalize(query)
  const c = normalize(candidate)
  if (!q || !c) return 0
  if (q === c) return 100
  if (c.startsWith(q)) return 85
  if (q.startsWith(c)) return 80
  if (c.includes(q)) return 70
  const qt = tokens(query)
  const ct = new Set(tokens(candidate))
  if (qt.length > 0 && qt.every((t) => ct.has(t))) {
    return 55 + Math.min(20, Math.round((qt.length / Math.max(1, ct.size)) * 20))
  }
  const overlap = qt.filter((t) => ct.has(t)).length
  if (overlap > 0) return Math.round((overlap / qt.length) * 45)
  return 0
}

export function bestMatch<T>(query: string, candidates: T[], label: (item: T) => string): T | undefined {
  let best: { item: T; score: number } | undefined
  for (const item of candidates) {
    const score = matchScore(query, label(item))
    if (!best || score > best.score) best = { item, score }
  }
  return best && best.score >= 45 ? best.item : undefined
}

export function resolveAddress(addresses: Address[], query: string): Address {
  const q = normalize(query)
  const byId = addresses.find((a) => a.id === query)
  if (byId) return byId
  const exactTag = addresses.filter((a) => a.tag && normalize(a.tag) === q)
  if (exactTag.length === 1) return exactTag[0]
  const tagPart = addresses.filter((a) => a.tag && matchScore(query, a.tag) >= 70)
  if (tagPart.length === 1) return tagPart[0]
  const linePart = addresses.filter((a) => matchScore(query, a.line) >= 70)
  if (linePart.length === 1) return linePart[0]
  const matches = exactTag.length > 1 ? exactTag : tagPart.length > 1 ? tagPart : linePart
  if (matches.length > 1) {
    throw new UserError(
      `Address "${query}" is ambiguous. Use an address tag or id:\n` +
        matches.map((a) => `  - ${a.tag || a.id}: ${a.line}`).join("\n"),
    )
  }
  throw new UserError(
    `No saved address matches "${query}". Available:\n` +
      addresses.map((a) => `  - ${a.tag || "(no tag)"}: ${a.line} [${a.id}]`).join("\n"),
  )
}

export function parseItemSpec(spec: string): { name: string; variant?: string } {
  const index = spec.lastIndexOf(":")
  if (index <= 0) return { name: spec.trim() }
  return { name: spec.slice(0, index).trim(), variant: spec.slice(index + 1).trim() || undefined }
}

export function parseItemRequest(spec: string): ItemRequest {
  let rest = spec.trim()
  let qty = 1
  const quantity = rest.match(/\s*[x×*]\s*(\d+)\s*$/i)
  if (quantity && quantity.index !== undefined) {
    qty = Math.max(1, Number(quantity[1]))
    rest = rest.slice(0, quantity.index).trim()
  }
  const { name, variant } = parseItemSpec(rest)
  if (!name) throw new UserError(`Bad item "${spec}".`)
  return { name, variant, qty }
}

export function collectCoupons(node: unknown, output: Coupon[] = [], seen = new Set<string>(), depth = 0): Coupon[] {
  if (!node || typeof node !== "object" || depth > 7) return output
  if (Array.isArray(node)) {
    for (const child of node) collectCoupons(child, output, seen, depth + 1)
    return output
  }
  const record = node as Record<string, any>
  const rawCode = record.coupon_code ?? record.couponCode ?? record.code ?? record.coupon_id
  const title =
    record.title ?? record.coupon_title ?? record.offer_title ?? record.description ?? record.header ?? record.name
  const discount =
    record.discount ??
    record.discount_amount ??
    record.max_discount ??
    record.savings ??
    record.coupon_discount ??
    record.value
  if (rawCode || (title && discount !== undefined)) {
    const code = rawCode ? String(rawCode) : undefined
    const label = String(title ?? code ?? "Offer")
    const key = `${code ?? ""}|${label}`
    if (!seen.has(key)) {
      seen.add(key)
      const applicable =
        record.applicable ?? record.is_applicable ?? record.isApplicable ?? record.eligible ?? record.is_eligible
      const amount = typeof discount === "number" ? discount : Number(discount)
      output.push({
        code,
        title: label,
        description: record.description && record.description !== label ? String(record.description) : undefined,
        discount: Number.isFinite(amount) ? amount : undefined,
        applicable: applicable === undefined ? undefined : Boolean(applicable),
      })
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") collectCoupons(value, output, seen, depth + 1)
  }
  return output
}

export function formatINR(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  const rounded = Math.round(value * 100) / 100
  return `₹${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`
}

export function redact(token: string): string {
  if (token.length <= 10) return "***"
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

type StoreState = { accounts: Account[] }

export class Store {
  dir: string
  file: string
  state: StoreState

  constructor(dir = configDir()) {
    this.dir = dir
    this.file = path.join(dir, "accounts.json")
    this.state = this.load()
  }

  private load(): StoreState {
    try {
      const raw = fs.readFileSync(this.file, "utf8")
      const parsed = JSON.parse(raw) as StoreState
      return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { accounts: [] }
      throw new UserError(`Cannot read ${this.file}: ${(error as Error).message}`)
    }
  }

  save(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const temp = `${this.file}.tmp`
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    fs.renameSync(temp, this.file)
    fs.chmodSync(this.file, 0o600)
  }

  list(): Account[] {
    return this.state.accounts
  }

  find(query: string): Account {
    const q = query.toLowerCase()
    const matches = this.state.accounts.filter(
      (a) => a.id.toLowerCase() === q || a.label.toLowerCase() === q || `${a.provider}:${a.label}`.toLowerCase() === q,
    )
    if (matches.length === 0) throw new UserError(`No account matches "${query}". See \`foodcompare accounts\`.`)
    if (matches.length > 1) {
      throw new UserError(
        `Account "${query}" is ambiguous:\n` + matches.map((a) => `  - ${a.id}`).join("\n"),
      )
    }
    return matches[0]
  }

  upsert(account: Account): void {
    const existing = this.state.accounts.findIndex((a) => a.id === account.id)
    if (existing >= 0) this.state.accounts[existing] = account
    else this.state.accounts.push(account)
    this.save()
  }

  remove(id: string): void {
    const before = this.state.accounts.length
    this.state.accounts = this.state.accounts.filter((a) => a.id !== id)
    if (this.state.accounts.length === before) throw new UserError(`No account with id ${id}`)
    this.save()
  }
}

export function accountId(provider: ProviderId, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `${provider}:${slug || "account"}`
}

export function makeAccount(
  provider: ProviderId,
  label: string,
  tokens: TokenSet,
  options: { phone?: string; client?: ClientInfo } = {},
): Account {
  return {
    id: accountId(provider, label),
    provider,
    label,
    phone: options.phone,
    tokens,
    client: options.client,
    addedAt: new Date().toISOString(),
  }
}

const OPENCODE_KEYS: Record<ProviderId, string> = { swiggy: "swiggy-food", zomato: "zomato" }

export function opencodeAuthPath(): string {
  return process.env.FOODCOMPARE_OPENCODE_AUTH || path.join(os.homedir(), ".local/share/opencode/mcp-auth.json")
}

export function importFromOpencode(provider: ProviderId, label: string, phone?: string): Account {
  const file = opencodeAuthPath()
  let data: Record<string, any>
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    throw new UserError(`Cannot read opencode auth at ${file}: ${(error as Error).message}`)
  }
  const entry = data[OPENCODE_KEYS[provider]]
  if (!entry) throw new UserError(`opencode has no "${OPENCODE_KEYS[provider]}" MCP entry.`)
  const tokens = entry.tokens
  if (!tokens?.accessToken || !tokens?.refreshToken) {
    throw new UserError(`opencode's "${OPENCODE_KEYS[provider]}" entry has no tokens yet. Authenticate it in opencode first.`)
  }
  const client: ClientInfo = {}
  if (entry.clientInfo?.clientId) client.clientId = entry.clientInfo.clientId
  if (entry.clientInfo?.clientSecret) client.clientSecret = entry.clientInfo.clientSecret
  return makeAccount(
    provider,
    label,
    {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Number(tokens.expiresAt) || 0,
    },
    { phone, client },
  )
}
