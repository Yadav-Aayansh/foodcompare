import crypto from "node:crypto"
import http from "node:http"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import type { Account, ProviderId, TokenSet } from "./core.ts"
import { UserError, configDir, makeAccount, nowSec } from "./core.ts"
import fs from "node:fs"
import path from "node:path"

export type ProviderMeta = {
  id: ProviderId
  name: string
  mcpUrl: string
  metadataUrl: string
  fallbackTokenEndpoint: string
  scope: string
  manualRedirect?: string
}

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  swiggy: {
    id: "swiggy",
    name: "Swiggy Food",
    mcpUrl: "https://mcp.swiggy.com/food",
    metadataUrl: "https://mcp.swiggy.com/.well-known/oauth-authorization-server",
    fallbackTokenEndpoint: "https://mcp.swiggy.com/auth/token",
    scope: "mcp:tools",
  },
  zomato: {
    id: "zomato",
    name: "Zomato",
    mcpUrl: "https://mcp-server.zomato.com/mcp",
    metadataUrl: "https://mcp-server.zomato.com/.well-known/oauth-authorization-server",
    fallbackTokenEndpoint: "https://mcp-server.zomato.com/token",
    scope: "mcp:tools",
    manualRedirect: "https://oauth.pstmn.io/v1/callback",
  },
}

export type OAuthMetadata = {
  issuer?: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
}

async function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(20_000), ...init })
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    const detail = cause?.code ?? cause?.message ?? (error as Error).message
    throw new UserError(`Cannot reach ${new URL(url).host}: ${detail}. Check your network/VPN and retry.`)
  }
}

export async function discover(provider: ProviderId): Promise<OAuthMetadata> {
  const meta = PROVIDERS[provider]
  const response = await httpFetch(meta.metadataUrl)
  if (!response.ok) {
    throw new UserError(`OAuth discovery failed for ${meta.name}: HTTP ${response.status}`)
  }
  return (await response.json()) as OAuthMetadata
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString("base64url")
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

type ClientCredentials = { clientId: string; clientSecret?: string }

async function register(metadata: OAuthMetadata, redirectUri: string): Promise<ClientCredentials> {
  if (!metadata.registration_endpoint) {
    throw new UserError("OAuth server does not support dynamic client registration.")
  }
  const response = await httpFetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "foodcompare",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:tools",
    }),
  })
  const text = await response.text()
  if (!response.ok) throw new UserError(`Client registration failed: HTTP ${response.status} ${text.slice(0, 200)}`)
  const data = JSON.parse(text) as { client_id?: string; client_secret?: string }
  if (!data.client_id) throw new UserError(`Client registration returned no client_id: ${text.slice(0, 200)}`)
  return { clientId: data.client_id, clientSecret: data.client_secret }
}

function authorizeUrl(
  metadata: OAuthMetadata,
  client: ClientCredentials,
  redirectUri: string,
  challenge: string,
  state: string,
  scope: string,
): string {
  const url = new URL(metadata.authorization_endpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", client.clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("scope", scope)
  url.searchParams.set("state", state)
  return url.toString()
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    child.on("error", () => {})
    child.unref()
  } catch {
    // The URL is printed by the caller; no browser is not fatal.
  }
}

type CallbackServer = {
  redirectUri: string
  wait: Promise<{ code: string }>
  close: () => void
}

function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      const address = server.address()
      resolve(typeof address === "object" && address ? address.port : port)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, "127.0.0.1")
  })
}

async function callbackServer(expectedState: string, options: { port?: number } = {}): Promise<CallbackServer> {
  let path = "/mcp/oauth/callback"
  let resolveResult: (value: { code: string }) => void = () => {}
  let rejectResult: (reason: Error) => void = () => {}
  const wait = new Promise<{ code: string }>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  const handler = (request: http.IncomingMessage, response: http.ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== path) {
      response.writeHead(404).end("not found")
      return
    }
    const error = url.searchParams.get("error")
    const code = url.searchParams.get("code")
    const state = url.searchParams.get("state")
    if (error) {
      response.writeHead(400, { "content-type": "text/html" }).end("<h1>Authorization failed</h1>")
      rejectResult(new UserError(`Authorization failed: ${url.searchParams.get("error_description") || error}`))
      return
    }
    if (state !== expectedState) {
      response.writeHead(400, { "content-type": "text/html" }).end("<h1>Invalid state</h1>")
      rejectResult(new UserError("OAuth state mismatch; login aborted."))
      return
    }
    if (!code) {
      response.writeHead(400, { "content-type": "text/html" }).end("<h1>Missing code</h1>")
      return
    }
    response
      .writeHead(200, { "content-type": "text/html" })
      .end("<h1>foodcompare is authenticated</h1><p>You can close this tab.</p>")
    resolveResult({ code })
  }
  const server = http.createServer(handler)
  let port: number
  try {
    port = await listen(server, options.port ?? 19876)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
    path = "/callback"
    port = await listen(server, 0)
  }
  const timer = setTimeout(() => {
    rejectResult(new UserError("Timed out waiting for the OTP login (5 minutes)."))
    server.close()
  }, 5 * 60_000)
  const close = () => {
    clearTimeout(timer)
    server.close()
  }
  return {
    redirectUri: `http://127.0.0.1:${port}${path}`,
    wait,
    close,
  }
}

async function exchange(
  metadata: OAuthMetadata,
  client: ClientCredentials,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    code_verifier: verifier,
  })
  if (client.clientSecret) body.set("client_secret", client.clientSecret)
  const response = await httpFetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new UserError(`Token exchange failed: HTTP ${response.status} ${text.slice(0, 300)}`)
  }
  const data = JSON.parse(text) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!data.access_token) {
    throw new UserError(`Token exchange returned no access_token: ${data.error_description || data.error || text.slice(0, 200)}`)
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    expiresAt: nowSec() + Number(data.expires_in ?? 5 * 24 * 3600),
  }
}

export async function authLoopback(
  provider: ProviderId,
  options: { label: string; phone?: string; noOpen?: boolean; print?: (text: string) => void },
): Promise<Account> {
  const meta = PROVIDERS[provider]
  const metadata = await discover(provider)
  const { verifier, challenge } = pkce()
  const state = crypto.randomBytes(24).toString("base64url")
  const server = await callbackServer(state)
  try {
    const client = await register(metadata, server.redirectUri)
    const url = authorizeUrl(metadata, client, server.redirectUri, challenge, state, meta.scope)
    options.print?.(`Open this URL to log in:\n${url}\n`)
    if (!options.noOpen) openBrowser(url)
    const { code } = await server.wait
    const tokens = await exchange(metadata, client, code, server.redirectUri, verifier)
    return makeAccount(provider, options.label, tokens, {
      phone: options.phone,
      client: { clientId: client.clientId, clientSecret: client.clientSecret, tokenEndpoint: metadata.token_endpoint },
    })
  } finally {
    server.close()
  }
}

function extractCode(input: string): string {
  const value = input.trim()
  try {
    const url = new URL(value)
    const error = url.searchParams.get("error")
    if (error) throw new UserError(`Authorization failed: ${url.searchParams.get("error_description") || error}`)
    return url.searchParams.get("code") || ""
  } catch (error) {
    if (error instanceof UserError) throw error
    return value
  }
}

export async function authManual(
  provider: ProviderId,
  options: { label: string; phone?: string; print?: (text: string) => void },
): Promise<Account> {
  const meta = PROVIDERS[provider]
  if (!meta.manualRedirect) throw new UserError(`${meta.name} does not need manual authentication.`)
  const metadata = await discover(provider)
  const client = await register(metadata, meta.manualRedirect)
  const { verifier, challenge } = pkce()
  const state = crypto.randomBytes(24).toString("base64url")
  const url = authorizeUrl(metadata, client, meta.manualRedirect, challenge, state, meta.scope)
  options.print?.(`Open this URL to log in:\n${url}\n`)
  const rl = createInterface({ input: stdin, output: stdout })
  let pasted = ""
  try {
    pasted = await rl.question("Paste the full redirected URL (or just the code) here: ")
  } finally {
    rl.close()
  }
  const code = extractCode(pasted)
  if (!code) throw new UserError("No authorization code provided.")
  const tokens = await exchange(metadata, client, code, meta.manualRedirect, verifier)
  return makeAccount(provider, options.label, tokens, {
    phone: options.phone,
    client: { clientId: client.clientId, clientSecret: client.clientSecret, tokenEndpoint: metadata.token_endpoint },
  })
}


type PendingAuth = {
  provider: ProviderId
  label: string
  phone?: string
  verifier: string
  state: string
  redirectUri: string
  client: ClientCredentials
  tokenEndpoint: string
  createdAt: number
}

export function pendingAuthPath(provider: ProviderId): string {
  return path.join(configDir(), `pending-${provider}.json`)
}

export async function authStart(
  provider: ProviderId,
  options: { label: string; phone?: string },
): Promise<{ url: string; file: string }> {
  const meta = PROVIDERS[provider]
  if (!meta.manualRedirect) {
    throw new UserError(`${meta.name} uses a loopback callback; run \`foodcompare auth add ${provider} --label <name>\`.`)
  }
  const metadata = await discover(provider)
  const client = await register(metadata, meta.manualRedirect)
  const { verifier, challenge } = pkce()
  const state = crypto.randomBytes(24).toString("base64url")
  const url = authorizeUrl(metadata, client, meta.manualRedirect, challenge, state, meta.scope)
  const pending: PendingAuth = {
    provider,
    label: options.label,
    phone: options.phone,
    verifier,
    state,
    redirectUri: meta.manualRedirect,
    client,
    tokenEndpoint: metadata.token_endpoint,
    createdAt: nowSec(),
  }
  const file = pendingAuthPath(provider)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(pending, null, 2), { mode: 0o600 })
  return { url, file }
}

export async function authFinish(provider: ProviderId, pasted: string): Promise<Account> {
  const meta = PROVIDERS[provider]
  const file = pendingAuthPath(provider)
  let pending: PendingAuth
  try {
    pending = JSON.parse(fs.readFileSync(file, "utf8")) as PendingAuth
  } catch (error) {
    throw new UserError(`No pending ${meta.name} login at ${file}. Run \`foodcompare auth start ${provider} --label <name>\` first.`)
  }
  if (pending.provider !== provider) throw new UserError(`Pending login is for ${pending.provider}, not ${provider}.`)
  if (nowSec() - pending.createdAt > 30 * 60) {
    throw new UserError("The pending login is older than 30 minutes; start again with `foodcompare auth start`.")
  }
  const code = extractCode(pasted)
  if (!code) throw new UserError("No authorization code provided.")
  const tokens = await exchange(
    {
      authorization_endpoint: "",
      token_endpoint: pending.tokenEndpoint,
    },
    pending.client,
    code,
    pending.redirectUri,
    pending.verifier,
  )
  const account = makeAccount(provider, pending.label, tokens, {
    phone: pending.phone,
    client: {
      clientId: pending.client.clientId,
      clientSecret: pending.client.clientSecret,
      tokenEndpoint: pending.tokenEndpoint,
    },
  })
  fs.rmSync(file, { force: true })
  return account
}

export async function refreshAccount(provider: ProviderId, account: Account): Promise<Account> {
  const meta = PROVIDERS[provider]
  const tokenEndpoint = account.client?.tokenEndpoint || meta.fallbackTokenEndpoint
  if (!account.tokens.refreshToken) {
    throw new UserError(`${meta.name} account "${account.label}" has no refresh token; re-authenticate.`)
  }
  if (!account.client?.clientId) {
    throw new UserError(`${meta.name} account "${account.label}" is missing a client id; re-authenticate.`)
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.tokens.refreshToken,
    client_id: account.client.clientId,
  })
  if (account.client.clientSecret) body.set("client_secret", account.client.clientSecret)
  const response = await httpFetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new UserError(
      `${meta.name} session expired for "${account.label}" (HTTP ${response.status}). Re-authenticate with \`foodcompare auth add ${provider} --label ${account.label}\`.`,
    )
  }
  const data = JSON.parse(text) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
  }
  if (!data.access_token) throw new UserError(`${meta.name} refresh returned no access_token.`)
  account.tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || account.tokens.refreshToken,
    expiresAt: nowSec() + Number(data.expires_in ?? 5 * 24 * 3600),
  }
  return account
}

export async function ensureFresh(account: Account): Promise<Account> {
  if (account.tokens.expiresAt - nowSec() > 120) return account
  return refreshAccount(account.provider, account)
}
