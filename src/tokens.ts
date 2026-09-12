import { DurableObject } from "cloudflare:workers"
import { TOKEN_URL } from "./oura.js"

export interface Env {
  OURA_CLIENT_ID: string
  OURA_CLIENT_SECRET: string
  MCP_BEARER: string
  OURA_REDIRECT_URI: string
  OURA_SANDBOX: string
  OURA_TOKENS: DurableObjectNamespace<OuraTokens>
}

/** Single-user server: one Durable Object owns the one token set. */
export const tokensFor = (env: Env) => env.OURA_TOKENS.getByName("owner")

type TokenSet = { accessToken: string; refreshToken: string; expiresAt: number }
type AuthState = { state: string; createdAt: number }

const responseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return text || undefined }
}

export class OuraTokens extends DurableObject<Env> {
  private inflight?: Promise<string>

  async beginAuth(): Promise<string> {
    const state = crypto.randomUUID()
    await this.ctx.storage.put<AuthState>("auth", { state, createdAt: Date.now() })
    return state
  }

  async completeAuth(state: string, code: string): Promise<void> {
    const auth = await this.ctx.storage.get<AuthState>("auth")
    if (!auth || auth.state !== state || Date.now() - auth.createdAt > 600_000)
      throw new Error("OAuth state is missing, invalid, or expired. Start authorization again.")
    await this.ctx.storage.delete("auth")
    const tokens = await this.postToken({
      grant_type: "authorization_code", code, redirect_uri: this.env.OURA_REDIRECT_URI,
    }, "authorization-code exchange")
    await this.ctx.storage.put("tokens", tokens)
  }

  async getAccessToken(): Promise<string> {
    const tokens = await this.ctx.storage.get<TokenSet>("tokens")
    if (tokens && tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken
    if (!tokens) throw new Error(`Not authorized. Visit ${new URL(this.env.OURA_REDIRECT_URI).origin}/oauth/start?token=<MCP_BEARER> once.`)
    if (!this.inflight) this.inflight = this.refresh(tokens.refreshToken).finally(() => { this.inflight = undefined })
    return this.inflight
  }

  async invalidate(): Promise<void> {
    const tokens = await this.ctx.storage.get<TokenSet>("tokens")
    if (tokens) await this.ctx.storage.put("tokens", { ...tokens, expiresAt: 0 })
  }

  async status(): Promise<{ authorized: boolean; expiresAt: number | null }> {
    const tokens = await this.ctx.storage.get<TokenSet>("tokens")
    return { authorized: !!tokens, expiresAt: tokens?.expiresAt ?? null }
  }

  private async refresh(refreshToken: string): Promise<string> {
    const tokens = await this.postToken({ grant_type: "refresh_token", refresh_token: refreshToken }, "refresh")
    await this.ctx.storage.put("tokens", tokens)
    return tokens.accessToken
  }

  private async postToken(grant: Record<string, string>, context: string): Promise<TokenSet> {
    let response: Response
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ ...grant, client_id: this.env.OURA_CLIENT_ID, client_secret: this.env.OURA_CLIENT_SECRET }),
      })
    } catch (error) {
      throw new Error(`Oura token request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const body = await responseBody(response)
    if (!response.ok) throw new Error(`Oura token ${context} failed (HTTP ${response.status}). ${JSON.stringify(body)}`)
    if (typeof body !== "object" || body === null) throw new Error("Oura token response was not JSON.")
    const json = body as Record<string, unknown>
    if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string")
      throw new Error("Oura token response was missing access_token or refresh_token.")
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (typeof json.expires_in === "number" ? json.expires_in : 86_400) * 1000,
    }
  }
}
