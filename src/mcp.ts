import { UserError } from "./core.ts"

export type ToolDef = {
  name: string
  description?: string
  inputSchema?: {
    type?: string
    properties?: Record<string, unknown>
    required?: string[]
  }
}

export type ToolResult = {
  data: any
  text: string
  raw: any
}

export class McpError extends Error {
  status?: number
  body?: string

  constructor(message: string, options: { status?: number; body?: string } = {}) {
    super(message)
    this.status = options.status
    this.body = options.body
  }
}

type ClientOptions = {
  url: string
  getToken: () => Promise<string>
  refresh?: () => Promise<void>
  allowTools?: string[]
  timeoutMs?: number
}

type JsonRpcResponse = {
  jsonrpc?: string
  id?: number | string | null
  result?: any
  error?: { code?: number; message?: string; data?: unknown }
}

export class McpClient {
  url: string
  getToken: () => Promise<string>
  refresh?: () => Promise<void>
  allowTools?: Set<string>
  timeoutMs: number
  sessionId?: string
  protocolVersion = "2025-06-18"
  private nextId = 1
  private initialized = false

  constructor(options: ClientOptions) {
    this.url = options.url
    this.getToken = options.getToken
    this.refresh = options.refresh
    this.allowTools = options.allowTools ? new Set(options.allowTools) : undefined
    this.timeoutMs = options.timeoutMs ?? 90_000
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken()
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId
    if (this.initialized) headers["mcp-protocol-version"] = this.protocolVersion
    return headers
  }

  private parseBody(text: string, contentType: string, id?: number): JsonRpcResponse | null {
    if (!text.trim()) return null
    if (contentType.includes("text/event-stream")) {
      const events = text.split(/\r?\n\r?\n/)
      const messages: JsonRpcResponse[] = []
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        try {
          messages.push(JSON.parse(data) as JsonRpcResponse)
        } catch {
          continue
        }
      }
      return (
        messages.find((message) => message.id !== undefined && message.id === id) ??
        messages.find((message) => message.result !== undefined || message.error !== undefined) ??
        null
      )
    }
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return (
          parsed.find((message: JsonRpcResponse) => message.id === id) ??
          parsed.find((message: JsonRpcResponse) => message.result !== undefined || message.error !== undefined) ??
          null
        )
      }
      return parsed as JsonRpcResponse
    } catch {
      throw new McpError(`Non-JSON response from ${this.url}: ${text.slice(0, 200)}`)
    }
  }

  private async post(
    payload: Record<string, unknown>,
    options: { timeoutMs?: number; retry?: boolean } = {},
  ): Promise<JsonRpcResponse | null> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const toolName = (payload.params as { name?: string } | undefined)?.name
    const retryTransport = toolName !== "create_cart"
    let response: Response | undefined
    let transportError: unknown
    for (let attempt = 0; attempt < (retryTransport ? 3 : 1); attempt++) {
      try {
        response = await fetch(this.url, {
          method: "POST",
          headers: await this.headers(),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        })
        break
      } catch (error) {
        transportError = error
        if (attempt === 2) break
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
    if (!response) {
      const cause = (transportError as { cause?: { code?: string; message?: string } })?.cause
      const detail = cause?.code ?? cause?.message ?? (transportError as Error)?.message ?? "unknown network error"
      throw new McpError(`Cannot reach ${this.url}: ${detail}. Check your network/VPN and retry.`)
    }
    const contentType = response.headers.get("content-type") ?? ""
    const text = await response.text()
    const sessionId = response.headers.get("mcp-session-id")
    if (sessionId) this.sessionId = sessionId
    if (response.status === 401 && options.retry !== false && this.refresh) {
      await this.refresh()
      return this.post(payload, { ...options, retry: false })
    }
    if (!response.ok) {
      throw new McpError(`HTTP ${response.status} from ${this.url}: ${text.slice(0, 300)}`, {
        status: response.status,
        body: text,
      })
    }
    if (response.status === 202 || response.status === 204) return null
    return this.parseBody(text, contentType, typeof payload.id === "number" ? payload.id : undefined)
  }

  private async rpc(method: string, params?: unknown) {
    const id = this.nextId++
    const message = await this.post({ jsonrpc: "2.0", id, method, params: params ?? {} })
    if (!message) throw new McpError(`Empty response for ${method}`)
    if (message.error) {
      throw new McpError(`${method} failed: ${message.error.message ?? JSON.stringify(message.error)}`, {
        body: JSON.stringify(message.error),
      })
    }
    return message.result
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    const result = await this.post(
      {
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "initialize",
        params: {
          protocolVersion: this.protocolVersion,
          capabilities: {},
          clientInfo: { name: "foodcompare", version: "0.1.0" },
        },
      },
      { timeoutMs: 20_000 },
    )
    if (result?.error) throw new McpError(`initialize failed: ${result.error.message ?? "unknown"}`)
    if (result?.result?.protocolVersion) this.protocolVersion = result.result.protocolVersion
    this.initialized = true
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, { timeoutMs: 20_000 })
  }

  async listTools(): Promise<ToolDef[]> {
    await this.initialize()
    const result = await this.rpc("tools/list")
    return (result?.tools ?? []) as ToolDef[]
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    if (this.allowTools && !this.allowTools.has(name)) {
      throw new UserError(`Refusing tool "${name}": not in the read-only allowlist.`)
    }
    await this.initialize()
    const result = await this.rpc("tools/call", { name, arguments: args })
    const text = (result?.content ?? [])
      .filter((part: any) => part?.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n")
    if (result?.isError) {
      throw new McpError(`${name} failed: ${text || "unknown error"}`, { body: text })
    }
    let data: any = result?.structuredContent
    if (data === undefined && text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    return { data, text, raw: result }
  }
}
