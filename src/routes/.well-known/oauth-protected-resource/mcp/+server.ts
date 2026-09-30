import { oauthOrigin, SCOPES, oauthHeaders } from '$lib/server/mcpAuth';
export const GET = ({ url }: { url: URL }) => { const origin = oauthOrigin(url.origin); return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: SCOPES, bearer_methods_supported: ['header'] }, { headers: oauthHeaders }); };
