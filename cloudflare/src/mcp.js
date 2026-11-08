// Read-only Streamable HTTP MCP endpoint for the single-owner Cloudflare runtime.
// The Cloudflare MCP Portal owns user-facing OAuth. The Worker trusts only its
// separately provisioned, high-entropy upstream Bearer and never passes it to openGym.
import { createMcpHandler } from 'agents/mcp/server'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { TOOLS } from '../../mcp/src/tools.js'
import { withRemoteState } from '../../mcp/src/state.js'

const headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}
const failure = (message, status) => new Response(JSON.stringify({error: message}), {
  status, headers: {...headers, 'Content-Type': 'application/json'}
})

async function authorized(presented, secret) {
  if (!presented?.startsWith('Bearer ') || typeof secret !== 'string' || secret.length < 32) return false
  const token = presented.slice(7)
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(token)), crypto.subtle.digest('SHA-256', enc.encode(secret))])
  const left = new Uint8Array(a), right = new Uint8Array(b)
  let mismatch = 0
  for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i]
  return mismatch === 0
}

function server() {
  const mcp = new McpServer({name:'opengym', title:'openGym', version:'0.1.0', description:'Read routines and training history from the connected openGym profile.'})
  for (const t of TOOLS) {
    mcp.registerTool(t.name, {
      title: t.name.replaceAll('_', ' '),
      description: t.description,
      inputSchema: z.object(t.schema),
      annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
    }, async params => {
      try {
        const result = await t.handler(params || {})
        return {content:[{type:'text',text:JSON.stringify(result)}]}
      } catch (err) {
        return {isError:true, content:[{type:'text',text:`${err.code || 'ERROR'}: ${err.message}`}]}
      }
    })
  }
  return mcp
}

const handler = createMcpHandler(server)
export async function handleMcp(request, env) {
  if (!(await authorized(request.headers.get('authorization'), env.MCP_UPSTREAM_TOKEN)))
    return failure('unauthorized', 401)
  let response
  try {
    const identity = await env.ACCOUNTS.getByName('accounts').fetch(new Request(new URL('/_internal/mcp-owner', request.url)))
    if (!identity.ok) return failure('MCP profile unavailable', 503)
    const {id} = await identity.json()
    if (typeof id !== 'string' || !id) return failure('MCP profile unavailable', 503)
    const profile = await env.PROFILES.getByName('profile:' + id).fetch(new Request(new URL('/api/data', request.url)))
    if (!profile.ok) return failure('MCP profile unavailable', 503)
    const {state} = await profile.json()
    if (!state || typeof state !== 'object') return failure('MCP profile unavailable', 503)
    response = await withRemoteState(state, () => handler(request, env))
  } catch (err) {
    console.error('MCP internal request failed:', err?.name || 'error')
    return failure('MCP unavailable', 503)
  }
  const out = new Response(response.body, response)
  for (const [k,v] of Object.entries(headers)) out.headers.set(k,v)
  return out
}
