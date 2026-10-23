#!/usr/bin/env node
import { createInterface } from "node:readline"
import { stdin } from "node:process"
import type { Account, Address } from "./core.ts"
import { Store, UserError, nowSec, parseItemRequest } from "./core.ts"
import { compare, formatCompare } from "./compare.ts"
import { swiggyAddresses } from "./swiggy.ts"
import { zomatoAddresses } from "./zomato.ts"

const VERSION = "0.1.0"
const PROTOCOL = "2025-06-18"

const TOOLS = [
  {
    name: "list_accounts",
    description: "List configured Swiggy/Zomato accounts. Tokens are never returned.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_addresses",
    description: "List saved delivery addresses for one or all configured accounts.",
    inputSchema: {
      type: "object",
      properties: { account: { type: "string", description: "Account label or id (optional)" } },
    },
  },
  {
    name: "compare_prices",
    description:
      "Compare the price of the same dishes across configured Swiggy/Zomato accounts and saved addresses. " +
      "Read-only: orders and payments are never placed. With exact=true a scratch cart is written per account " +
      "to read the real delivery fee/taxes, then emptied; a non-empty cart is left untouched unless replaceCart=true.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Saved address tag or id, applied to every account" },
        addresses: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Per-account address overrides, keyed by account label or id",
        },
        restaurant: { type: "string", description: "Restaurant name" },
        restaurantId: { type: "string", description: "Restaurant id (optional)" },
        items: {
          type: "array",
          items: { type: "string" },
          description: 'Dish specs such as "Veg Chow Mein:Half x2" or "Spring Roll"',
        },
        accounts: { type: "array", items: { type: "string" }, description: "Account labels/ids (default: all)" },
        exact: {
          type: "boolean",
          description: "Read the real payable amount via a scratch cart (default false: estimate only)",
        },
        replaceCart: { type: "boolean", description: "Allow clearing a non-empty cart in exact mode" },
        applyBestCoupon: { type: "boolean", description: "Apply the best applicable coupon in exact mode" },
      },
      required: ["address", "items"],
    },
  },
] as const

function send(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id: unknown, value: unknown): void {
  send({ jsonrpc: "2.0", id, result: value })
}

function error(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

function publicAccount(account: Account) {
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    expiresInSeconds: account.tokens.expiresAt - nowSec(),
  }
}

async function accountAddresses(account: Account, store: Store): Promise<Address[]> {
  return account.provider === "swiggy" ? swiggyAddresses(account, store) : zomatoAddresses(account, store)
}

function selectAccounts(store: Store, refs?: string[]): Account[] {
  if (!refs || refs.length === 0) {
    if (store.list().length === 0) throw new UserError("No accounts configured.")
    return store.list()
  }
  return refs.map((ref) => store.find(ref))
}

async function listAddresses(args: Record<string, unknown>): Promise<any> {
  const store = new Store()
  const accounts = selectAccounts(store, args.account ? [String(args.account)] : undefined)
  const data: Record<string, unknown> = {}
  const lines: string[] = []
  for (const account of accounts) {
    try {
      const addresses = await accountAddresses(account, store)
      data[account.id] = addresses
      lines.push(`${account.label} (${account.id})`)
      for (const address of addresses) lines.push(`  - ${address.tag ?? "(no tag)"}: ${address.line} [${address.id}]`)
    } catch (caught) {
      data[account.id] = { error: (caught as Error).message }
      lines.push(`${account.label}: ${(caught as Error).message}`)
    }
  }
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { accounts: data } }
}

async function comparePrices(args: Record<string, unknown>): Promise<any> {
  const store = new Store()
  const rawItems = args.items
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new UserError("items must be a non-empty array.")
  const items = rawItems.map((item) => parseItemRequest(String(item)))
  if (!args.address && !args.addresses) throw new UserError("address is required.")
  const accountRefs = Array.isArray(args.accounts) ? args.accounts.map(String) : undefined
  const accounts = selectAccounts(store, accountRefs)
  const overrides = (args.addresses ?? {}) as Record<string, string>
  const defaultAddress = args.address ? String(args.address) : undefined
  const exact = args.exact === true
  const results = await compare({
    accounts,
    address: (account) => overrides[account.id] ?? overrides[account.label] ?? defaultAddress ?? "",
    request: {
      restaurant: args.restaurant ? String(args.restaurant) : undefined,
      restaurantId: args.restaurantId ? String(args.restaurantId) : undefined,
      items,
      estimate: !exact,
      replaceCart: args.replaceCart === true,
      applyBestCoupon: args.applyBestCoupon === true,
    },
    store,
  })
  const text = formatCompare(results)
  const ok = results.some((entry) => entry.quote)
  return {
    content: [{ type: "text", text }],
    structuredContent: {
      ok,
      estimate: !exact,
      results: results.map((entry) => ({
        account: { id: entry.account.id, label: entry.account.label, provider: entry.account.provider },
        quote: entry.quote,
        error: entry.error,
      })),
    },
    isError: !ok,
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  if (name === "list_accounts") {
    const store = new Store()
    const accounts = store.list().map(publicAccount)
    const text = accounts.length
      ? accounts.map((account) => `${account.id} (${account.label}) · ${account.provider}`).join("\n")
      : "No accounts. Run `foodcompare auth add swiggy --label <name>`."
    return { content: [{ type: "text", text }], structuredContent: { accounts } }
  }
  if (name === "list_addresses") return listAddresses(args)
  if (name === "compare_prices") return comparePrices(args)
  throw new UserError(`Unknown tool "${name}".`)
}

async function handle(message: any): Promise<void> {
  if (!message || message.jsonrpc !== "2.0") return
  const id = message.id
  const method = message.method
  const isNotification = id === undefined || id === null
  try {
    if (method === "initialize") {
      result(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "foodcompare", version: VERSION },
      })
      return
    }
    if (method === "ping") {
      result(id, {})
      return
    }
    if (method === "tools/list") {
      result(id, { tools: TOOLS })
      return
    }
    if (method === "tools/call") {
      const name = message.params?.name
      const args = message.params?.arguments ?? {}
      if (typeof name !== "string") throw new UserError("tools/call requires a tool name.")
      const value = await callTool(name, args)
      if (isNotification) return
      result(id, value)
      return
    }
    if (isNotification) return
    error(id, -32601, `Method not found: ${method}`)
  } catch (caught) {
    if (isNotification) return
    if (method === "tools/call") {
      const text = caught instanceof UserError ? caught.message : ((caught as Error).stack ?? String(caught))
      result(id, { content: [{ type: "text", text }], isError: true })
      return
    }
    error(id, -32603, caught instanceof UserError ? caught.message : String(caught))
  }
}

const lines = createInterface({ input: stdin, crlfDelay: Infinity })
lines.on("line", (line) => {
  if (!line.trim()) return
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    error(null, -32700, "Parse error")
    return
  }
  void handle(message)
})
