#!/usr/bin/env node
import { argv } from "node:process"
import type { Account, ItemRequest, ProviderId, Store as StoreType } from "./core.ts"
import { Store, UserError, importFromOpencode, nowSec, parseItemRequest } from "./core.ts"
import { PROVIDERS, authFinish, authLoopback, authManual, authStart, ensureFresh, refreshAccount } from "./auth.ts"
import { swiggyAddresses } from "./swiggy.ts"
import { zomatoAddresses } from "./zomato.ts"
import { compare, formatCompare, requireAccounts } from "./compare.ts"
import { McpClient } from "./mcp.ts"

const VERSION = "0.1.0"

const BOOLEAN_FLAGS = new Set([
  "json",
  "exact",
  "estimate",
  "replace-cart",
  "apply-best-coupon",
  "manual",
  "loopback",
  "no-open",
  "help",
  "version",
  "all",
])

type Args = {
  positional: string[]
  flags: Map<string, string[]>
}

function parseArgs(input: string[]): Args {
  const positional: string[] = []
  const flags = new Map<string, string[]>()
  for (let index = 0; index < input.length; index++) {
    const arg = input[index]
    if (arg === "--") {
      positional.push(...input.slice(index + 1))
      break
    }
    if (arg === "-h") {
      push(flags, "help", "true")
      continue
    }
    if (arg === "-v") {
      push(flags, "version", "true")
      continue
    }
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    let body = arg.slice(2)
    let inline: string | undefined
    const equals = body.indexOf("=")
    if (equals >= 0) {
      inline = body.slice(equals + 1)
      body = body.slice(0, equals)
    }
    if (BOOLEAN_FLAGS.has(body)) {
      if (inline !== undefined) throw new UserError(`--${body} does not take a value.`)
      push(flags, body, "true")
      continue
    }
    const value = inline ?? input[++index]
    if (value === undefined) throw new UserError(`--${body} needs a value.`)
    push(flags, body, value)
  }
  return { positional, flags }
}

function push(flags: Map<string, string[]>, key: string, value: string) {
  const existing = flags.get(key)
  if (existing) existing.push(value)
  else flags.set(key, [value])
}

function has(args: Args, key: string): boolean {
  return args.flags.has(key)
}

function one(args: Args, key: string): string | undefined {
  const values = args.flags.get(key)
  return values?.[values.length - 1]
}

function many(args: Args, key: string): string[] {
  return args.flags.get(key) ?? []
}

function help(): void {
  console.log(`foodcompare ${VERSION} — read-only food price comparison

Usage:
  foodcompare auth add <swiggy|zomato> --label <name> [--phone <number>] [--manual] [--no-open]
  foodcompare auth import <swiggy|zomato> [--label <name>] [--phone <number>]
  foodcompare auth start <zomato> --label <name> [--phone <number>]
  foodcompare auth finish <zomato> --code '<redirected-url-or-code>' 
  foodcompare auth list [provider] [--json]
  foodcompare auth remove <account>

  foodcompare addresses [--account <name>] [--json]

  foodcompare compare --address <tag|id> --restaurant "<name>" --items "<dish[:variant] [xN], ...>"
      [--account <name>]... [--address <account>=<tag|id>]...
      [--restaurant-id <id>] [--estimate] [--replace-cart] [--apply-best-coupon] [--json]

  foodcompare tools <swiggy|zomato> [--account <name>] [--json]

Compare defaults to --exact: it writes a scratch cart per account to read the real
delivery fee/taxes, then empties it. It refuses to touch a non-empty cart unless
--replace-cart is given. --estimate never writes but excludes fees/taxes.
Orders and payments are never placed.

Examples:
  foodcompare auth import swiggy --label AK --phone 9876543210
  foodcompare addresses --account AK
  foodcompare compare --account AK --address AK --restaurant "Savera Sudh Vaishno Hotel" --items "Veg Chow Mein:Half x2, Spring Roll"
  foodcompare compare --account AK --account Dad --address Home --restaurant "Domino's Pizza" --items "Margherita" --json`)
}

async function authCommand(args: Args): Promise<void> {
  const [action, providerArg] = args.positional
  const store = new Store()
  if (!action) throw new UserError("Usage: foodcompare auth <add|import|list|remove> ...")

  if (action === "list") {
    const provider = providerArg as ProviderId | undefined
    const accounts = store.list().filter((account) => !provider || account.provider === provider)
    if (has(args, "json")) {
      console.log(JSON.stringify(accounts.map(publicAccount), null, 2))
      return
    }
    if (accounts.length === 0) {
      console.log("No accounts. Run `foodcompare auth add swiggy --label <name>`.")
      return
    }
    for (const account of accounts) {
      const remaining = account.tokens.expiresAt - nowSec()
      const state = remaining <= 0 ? "expired (refreshes on use)" : `expires in ${Math.max(1, Math.floor(remaining / 86400))}d`
      const phone = account.phone ? ` · ${maskPhone(account.phone)}` : ""
      console.log(`${account.id}  ${account.label}  ${state}${phone}`)
    }
    return
  }

  if (action === "remove") {
    const query = providerArg ?? one(args, "account")
    if (!query) throw new UserError("Usage: foodcompare auth remove <account>")
    const account = store.find(query)
    store.remove(account.id)
    console.log(`Removed ${account.id}.`)
    return
  }

  if (action === "start") {
    const provider = providerArg as ProviderId | undefined
    if (!provider || !PROVIDERS[provider]) throw new UserError("Usage: foodcompare auth start <zomato> --label <name>")
    const label = one(args, "label")
    if (!label) throw new UserError("--label is required, e.g. --label Dad.")
    const pending = await authStart(provider, { label, phone: one(args, "phone") })
    console.log("Open this URL and complete the OTP login:\n")
    console.log(pending.url)
    console.log(`\nThen copy the full redirected URL and run:\n  foodcompare auth finish ${provider} --code '<redirected-url>'`)
    console.log(`Pending login: ${pending.file}`)
    return
  }

  if (action === "finish") {
    const provider = providerArg as ProviderId | undefined
    if (!provider || !PROVIDERS[provider]) throw new UserError("Usage: foodcompare auth finish <zomato> --code '<redirected-url>'")
    const code = one(args, "code") ?? args.positional[2]
    if (!code) throw new UserError("--code is required (the full redirected URL or the code).")
    const account = await authFinish(provider, code)
    store.upsert(account)
    console.log(`Saved ${account.id}.`)
    return
  }

  if (action !== "add" && action !== "import") {
    throw new UserError(`Unknown auth action "${action}".`)
  }
  const provider = providerArg as ProviderId | undefined
  if (!provider || !PROVIDERS[provider]) throw new UserError("Usage: foodcompare auth add <swiggy|zomato> --label <name>")

  const phone = one(args, "phone")
  if (action === "import") {
    const label = one(args, "label") ?? provider
    const account = importFromOpencode(provider, label, phone)
    store.upsert(account)
    console.log(`Imported ${provider} account as ${account.id}.`)
    return
  }

  const label = one(args, "label")
  if (!label) throw new UserError("--label is required, e.g. --label Dad.")
  const manual = has(args, "manual") || (provider === "zomato" && !has(args, "loopback"))
  console.log(`Authenticating ${PROVIDERS[provider].name} as "${label}"${manual ? " (manual callback)" : ""}.`)
  const options = {
    label,
    phone,
    print: (text: string) => console.log(text.trim()),
  }
  const account = manual
    ? await authManual(provider, options)
    : await authLoopback(provider, { ...options, noOpen: has(args, "no-open") })
  store.upsert(account)
  console.log(`Saved ${account.id}.`)
}

function publicAccount(account: Account) {
  const remaining = account.tokens.expiresAt - nowSec()
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    phone: account.phone,
    expiresAt: account.tokens.expiresAt,
    expiresInSeconds: remaining,
  }
}

function maskPhone(phone: string): string {
  return phone.length >= 4 ? `****${phone.slice(-4)}` : "****"
}

function selectAccounts(store: StoreType, args: Args): Account[] {
  const refs = many(args, "account")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
  if (refs.length === 0) return requireAccounts(store.list())
  const accounts = refs.map((ref) => store.find(ref))
  return [...new Map(accounts.map((account) => [account.id, account])).values()]
}

async function addressesCommand(args: Args): Promise<void> {
  const store = new Store()
  const accounts = selectAccounts(store, args)
  const output: Record<string, unknown> = {}
  for (const account of accounts) {
    try {
      const addresses =
        account.provider === "swiggy"
          ? await swiggyAddresses(account, store)
          : await zomatoAddresses(account, store)
      output[account.id] = addresses
      if (!has(args, "json")) {
        console.log(`${account.label} (${account.id})`)
        for (const address of addresses) {
          console.log(`  - ${address.tag ?? "(no tag)"}: ${address.line} [${address.id}]`)
        }
      }
    } catch (error) {
      output[account.id] = { error: (error as Error).message }
      if (!has(args, "json")) console.error(`${account.label}: ${(error as Error).message}`)
    }
  }
  if (has(args, "json")) console.log(JSON.stringify(output, null, 2))
}

function parseItems(args: Args): ItemRequest[] {
  const specs = [...many(args, "item")]
  const combined = one(args, "items")
  if (combined) specs.push(...combined.split(","))
  const items: ItemRequest[] = []
  for (const raw of specs) {
    if (!raw.trim()) continue
    items.push(parseItemRequest(raw))
  }
  if (items.length === 0) throw new UserError('Provide --items "Dish[:Variant] [xN], ..."')
  return items
}

async function compareCommand(args: Args): Promise<void> {
  const store = new Store()
  const accounts = selectAccounts(store, args)
  const items = parseItems(args)
  const restaurant = one(args, "restaurant")
  const restaurantId = one(args, "restaurant-id")
  if (!restaurant && !restaurantId) throw new UserError("Provide --restaurant (or --restaurant-id).")

  const defaultAddress = many(args, "address")
    .filter((value) => !value.includes("="))
    .at(-1)
  const addressMap = new Map<string, string>()
  for (const value of many(args, "address").filter((entry) => entry.includes("="))) {
    const index = value.indexOf("=")
    const who = value.slice(0, index).trim()
    const query = value.slice(index + 1).trim()
    if (!who || !query) throw new UserError(`Bad --address "${value}". Use --address <account>=<tag|id>.`)
    addressMap.set(store.find(who).id, query)
  }
  if (!defaultAddress) {
    for (const account of accounts) {
      if (!addressMap.has(account.id)) {
        throw new UserError(`No address for ${account.label}. Use --address <tag|id> or --address ${account.label}=<tag|id>.`)
      }
    }
  }

  if (has(args, "exact") && has(args, "estimate")) throw new UserError("Use either --exact or --estimate, not both.")
  const estimate = has(args, "estimate")
  const results = await compare({
    accounts,
    address: (account) => addressMap.get(account.id) ?? defaultAddress ?? "",
    request: {
      restaurant,
      restaurantId,
      items,
      estimate,
      replaceCart: has(args, "replace-cart"),
      applyBestCoupon: has(args, "apply-best-coupon"),
    },
    store,
  })

  if (has(args, "json")) {
    console.log(
      JSON.stringify(
        {
          ok: results.some((result) => result.quote),
          estimate,
          results: results.map((result) => ({
            account: { id: result.account.id, label: result.account.label, provider: result.account.provider },
            quote: result.quote,
            error: result.error,
          })),
        },
        null,
        2,
      ),
    )
  } else {
    const mode = estimate ? "estimate (no cart writes)" : "exact (scratch cart)"
    console.log(`${accounts.length} account(s) · ${mode} · ${restaurant ?? restaurantId}`)
    console.log("")
    console.log(formatCompare(results))
  }
  if (!results.some((result) => result.quote)) process.exitCode = 1
}

async function toolsCommand(args: Args): Promise<void> {
  const provider = args.positional[0] as ProviderId | undefined
  if (!provider || !PROVIDERS[provider]) throw new UserError("Usage: foodcompare tools <swiggy|zomato> [--account <name>]")
  const store = new Store()
  const accounts = store.list().filter((account) => account.provider === provider)
  const ref = one(args, "account") ?? accounts[0]?.label
  if (!ref) throw new UserError(`No ${provider} account. Run \`foodcompare auth add ${provider} --label <name>\`.`)
  const account = store.find(ref)
  const client = new McpClient({
    url: PROVIDERS[provider].mcpUrl,
    getToken: async () => {
      if (account.tokens.expiresAt - nowSec() <= 120) {
        await ensureFresh(account)
        store.upsert(account)
      }
      return account.tokens.accessToken
    },
    refresh: async () => {
      await refreshAccount(provider, account)
      store.upsert(account)
    },
  })
  const tools = await client.listTools()
  if (has(args, "json")) {
    console.log(JSON.stringify(tools, null, 2))
    return
  }
  for (const tool of tools) {
    const required = tool.inputSchema?.required ?? []
    console.log(`${tool.name}(${required.join(", ")})`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2))
  if (has(args, "version")) {
    console.log(VERSION)
    return
  }
  const [command] = args.positional
  if (!command || command === "help" || has(args, "help")) {
    help()
    return
  }
  const rest = { ...args, positional: args.positional.slice(1) }
  if (command === "auth") return authCommand(rest)
  if (command === "addresses") return addressesCommand(rest)
  if (command === "compare") return compareCommand(rest)
  if (command === "tools") return toolsCommand(rest)
  throw new UserError(`Unknown command "${command}". Try \`foodcompare help\`.`)
}

main().catch((error) => {
  const message = error instanceof UserError ? error.message : (error as Error).stack ?? String(error)
  console.error(`foodcompare: ${message}`)
  process.exitCode = 1
})
