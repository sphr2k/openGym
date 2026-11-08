// Dedicated Streamable HTTP MCP Worker. Does not share the user's browser Access policy.
// The MCP Portal authenticates callers; the upstream secret gates every request to /mcp.
import {handleMcp} from './mcp.js'
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname !== '/mcp')
      return new Response('Not found', {status:404,headers:{'Cache-Control':'no-store'}})
    return handleMcp(request, env)
  }
}
