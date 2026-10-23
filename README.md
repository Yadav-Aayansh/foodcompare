# foodcompare

Compare the final price of the same food order on Swiggy and Zomato, across one or more accounts. It only reads prices and builds temporary carts. It never places an order.

## 1. Install

Requires Node 24 or newer.

```bash
cd foodcompare
npm install
npm link
```

## 2. Add an account

Swiggy:

```bash
foodcompare auth add swiggy --label swiggy-1 --phone 9876543210
```

Finish the login in the browser.

Zomato:

```bash
foodcompare auth add zomato --label zomato-1 --phone 9876543210
```

Open the printed URL, finish the login, then paste the redirected URL when asked.

Check what is saved:

```bash
foodcompare auth list
```

## 3. Find an address

```bash
foodcompare addresses --account swiggy-1
```

Use the address tag or id in the next step.

## 4. Compare

Estimate. No cart writes.

```bash
foodcompare compare --estimate \
  --account swiggy-1 --account zomato-1 \
  --address swiggy-1=Home --address zomato-1=YOUR_ADDRESS_ID \
  --restaurant "Domino's Pizza" \
  --items "Margherita:Medium x2"
```

Exact. Run the same command without `--estimate`. It builds a temporary cart to read delivery, fees, taxes and offers, then clears it on Swiggy. Zomato has no clear-cart tool, so its cart is left on the account.

Add `--json` for machine output.

## 5. Use the MCP server

The package installs `foodcompare-mcp`, a stdio MCP server. Add this command to your MCP client:

```bash
foodcompare-mcp
```

Tools: `list_accounts`, `list_addresses`, `compare_prices`. MCP comparisons default to estimates. Set `exact` to read the real total.

## Notes

- Tokens live in `~/.config/foodcompare/accounts.json` with mode 0600.
- Exact mode refuses to touch a non-empty Swiggy cart unless you pass `--replace-cart`.
- Zomato may auto-apply an offer. The shown total includes it.
- Swiggy often hides variant prices. Estimates use the base item price, so use exact for the final number.
