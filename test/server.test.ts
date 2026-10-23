import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("MCP stdio server exposes only the read-only tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "foodcompare-test-"))
  const child = spawn(process.execPath, ["src/mcp-server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, FOODCOMPARE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  })
  const lines = createInterface({ input: child.stdout })
  let nextId = 1
  const pending = new Map<number, (message: any) => void>()
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line)
      if (typeof message.id === "number") pending.get(message.id)?.(message)
    } catch {
      // ignore non-JSON stdout
    }
  })
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`timeout waiting for ${method}`))
        }
      }, 5000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        pending.delete(id)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  try {
    const initialize = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    })
    assert.equal(initialize.result.serverInfo.name, "foodcompare")
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
    const tools = await request("tools/list")
    assert.deepEqual(
      tools.result.tools.map((tool: any) => tool.name),
      ["list_accounts", "list_addresses", "compare_prices"],
    )
    const accounts = await request("tools/call", { name: "list_accounts", arguments: {} })
    assert.match(accounts.result.content[0].text, /No accounts/)
    const bad = await request("tools/call", { name: "compare_prices", arguments: {} })
    assert.equal(bad.result.isError, true)
    const unknown = await request("tools/call", { name: "place_order", arguments: {} })
    assert.equal(unknown.result.isError, true)
  } finally {
    child.kill()
    lines.close()
    rmSync(home, { recursive: true, force: true })
  }
})
