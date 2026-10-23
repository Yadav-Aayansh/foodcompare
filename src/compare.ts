import type { Account, Quote, QuoteRequest, Store } from "./core.ts"
import { UserError, formatINR } from "./core.ts"
import { swiggyQuote } from "./swiggy.ts"
import { zomatoQuote } from "./zomato.ts"

export type CompareOptions = {
  accounts: Account[]
  address: (account: Account) => string
  request: Omit<QuoteRequest, "address">
  store?: Store
}

export type CompareResult = {
  account: Account
  quote?: Quote
  error?: string
}

export async function compare(options: CompareOptions): Promise<CompareResult[]> {
  const results: CompareResult[] = []
  for (const account of options.accounts) {
    const request: QuoteRequest = { ...options.request, address: options.address(account) }
    try {
      const quote =
        account.provider === "swiggy"
          ? await swiggyQuote(account, request, options.store)
          : await zomatoQuote(account, request, options.store)
      results.push({ account, quote })
    } catch (error) {
      results.push({ account, error: (error as Error).message })
    }
  }
  return results
}

export function rank(results: CompareResult[]): CompareResult[] {
  return [...results].sort((a, b) => {
    const left = a.quote ? a.quote.pricing.toPay ?? a.quote.pricing.itemTotal ?? Infinity : Infinity
    const right = b.quote ? b.quote.pricing.toPay ?? b.quote.pricing.itemTotal ?? Infinity : Infinity
    return left - right
  })
}

export function formatQuote(quote: Quote): string {
  const { restaurant, address, pricing } = quote
  const facts = [restaurant.distanceKm !== undefined ? `${restaurant.distanceKm} km` : "", restaurant.etaMinutes ? `${restaurant.etaMinutes} min` : ""]
    .filter(Boolean)
    .join(" · ")
  const lines: string[] = []
  lines.push(`${quote.accountLabel} (${quote.accountId})`)
  lines.push(`  ${restaurant.name}${facts ? ` · ${facts}` : ""}`)
  for (const line of quote.lines) {
    const variant = line.variant ? ` (${line.variant})` : ""
    lines.push(`  ${line.name}${variant} x${line.qty}  ${formatINR(line.lineTotal)}`)
  }
  if (pricing.itemTotal !== null) lines.push(`  Item total: ${formatINR(pricing.itemTotal)}`)
  if (pricing.delivery !== null) lines.push(`  Delivery: ${formatINR(pricing.delivery)}`)
  if (pricing.fees !== undefined && pricing.fees !== null) lines.push(`  Fees: ${formatINR(pricing.fees)}`)
  if (pricing.taxes !== null) lines.push(`  Taxes: ${formatINR(pricing.taxes)}`)
  if (pricing.discount) lines.push(`  Discount: -${formatINR(pricing.discount)}`)
  lines.push(`  ${quote.estimate ? "Estimated" : "To pay"}: ${formatINR(pricing.toPay ?? pricing.itemTotal)}`)
  const couponLabel = quote.provider === "swiggy" ? "Coupons (COD-only, not applied)" : "Offers (not applied)"
  const applied = quote.coupons.filter((coupon) => coupon.applied)
  const available = quote.coupons.filter((coupon) => !coupon.applied)
  if (applied.length > 0) {
    lines.push(
      `  Applied: ${applied
        .map((coupon) => {
          const name = coupon.code ?? coupon.title
          return coupon.discount ? `${name} (-${formatINR(coupon.discount)})` : name
        })
        .join(", ")}`,
    )
  }
  if (available.length > 0) {
    lines.push(`  ${couponLabel}: ${available.map((coupon) => coupon.code ?? coupon.title).join(", ")}`)
  } else if (applied.length === 0) {
    lines.push("  Coupons: none available")
  }
  if (!quote.estimate) lines.push(`  Address: ${address.line}`)
  for (const warning of quote.warnings) lines.push(`  ! ${warning}`)
  return lines.join("\n")
}

export function formatCompare(results: CompareResult[]): string {
  const ranked = rank(results)
  const blocks: string[] = []
  const failures = ranked.filter((result) => !result.quote)
  for (const result of ranked) {
    if (!result.quote) continue
    blocks.push(formatQuote(result.quote))
  }
  const rows: string[] = []
  const quoted = ranked.filter((result) => result.quote)
  if (quoted.length > 0) {
    const anyEstimate = quoted.some((result) => result.quote?.estimate)
    const anyFees = quoted.some(
      (result) => result.quote?.pricing.fees !== undefined && result.quote.pricing.fees !== null,
    )
    const header = ["#", "Account", anyEstimate ? "Amount" : "To pay", "Items", "Delivery"]
    if (anyFees) header.push("Fees")
    header.push("Taxes")
    rows.push(header.join("\t"))
    quoted.forEach((result, index) => {
      const quote = result.quote!
      const row = [
        String(index + 1),
        quote.accountLabel + (quoted.length > 1 && index === 0 ? " (best)" : ""),
        formatINR(quote.pricing.toPay ?? quote.pricing.itemTotal),
        formatINR(quote.pricing.itemTotal),
        formatINR(quote.pricing.delivery),
      ]
      if (anyFees) row.push(formatINR(quote.pricing.fees ?? null))
      row.push(formatINR(quote.pricing.taxes))
      rows.push(row.join("\t"))
    })
  }
  if (rows.length > 0) blocks.push(`Summary\n${rows.join("\n")}`)
  if (failures.length > 0) {
    blocks.push(
      "Failed\n" + failures.map((result) => `  ${result.account.label} (${result.account.id}): ${result.error}`).join("\n"),
    )
  }
  return blocks.join("\n\n")
}

export function requireAccounts(accounts: Account[]): Account[] {
  if (accounts.length === 0) {
    throw new UserError("No accounts configured. Run `foodcompare auth import swiggy --label <name>` or `foodcompare auth add swiggy --label <name>`.")
  }
  return accounts
}
