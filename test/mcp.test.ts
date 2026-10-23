import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { McpClient } from "../src/mcp.ts"
import { UserError } from "../src/core.ts"

type Handler = (name: string, args: Record<string, unknown>, authorization: string) => { status?: number; result?: any }

function mockServer(handler: Handler) {
  const calls: string[] = []
  const server = http.createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => (body += chunk))
    request.on("end", () => {
      const message = JSON.parse(body)
      if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "text/event-stream" })
        response.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "0" } },
          })}\n\n`,
        )
        return
      }
      if (!message.id) {
        response.writeHead(202).end()
        return
      }
      calls.push(message.method)
      if (message.method === "tools/call") {
        const { name, arguments: args } = message.params
        const outcome = handler(name, args, request.headers.authorization ?? "")
        if (outcome.status && outcome.status !== 200) {
          response.writeHead(outcome.status, { "content-type": "application/json" }).end("{}")
          return
        }
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [{ type: "text", text: JSON.stringify(outcome.result) }],
              structuredContent: outcome.result,
            },
          }),
        )
        return
      }
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }),
      )
    })
  })
  return new Promise<{ url: string; calls: string[]; close: () => void }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        calls,
        close: () => server.close(),
      })
    })
  })
}

test("McpClient initializes over SSE, calls tools and enforces the allowlist", async () => {
  const mock = await mockServer((_name, args) => ({ result: { echo: args } }))
  try {
    const client = new McpClient({
      url: mock.url,
      getToken: async () => "token-1",
      allowTools: ["echo"],
    })
    const result = await client.callTool("echo", { value: 42 })
    assert.deepEqual(result.data, { echo: { value: 42 } })
    await assert.rejects(() => client.callTool("place_order", {}), UserError)
    assert.equal(mock.calls.filter((call) => call === "tools/call").length, 1)
  } finally {
    mock.close()
  }
})

test("McpClient refreshes once on a 401 and retries", async () => {
  let token = "old"
  let refreshed = 0
  const mock = await mockServer((_name, _args, authorization) => {
    if (authorization === "Bearer old") return { status: 401 }
    return { result: { ok: true } }
  })
  try {
    const client = new McpClient({
      url: mock.url,
      getToken: async () => token,
      refresh: async () => {
        refreshed++
        token = "new"
      },
    })
    const result = await client.callTool("echo", {})
    assert.deepEqual(result.data, { ok: true })
    assert.equal(refreshed, 1)
  } finally {
    mock.close()
  }
})
