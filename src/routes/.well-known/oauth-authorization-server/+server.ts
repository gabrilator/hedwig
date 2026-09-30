import { authMetadata, oauthOrigin, oauthHeaders } from '$lib/server/mcpAuth';
export const GET = ({ url }: { url: URL }) => Response.json(authMetadata(oauthOrigin(url.origin)), { headers: oauthHeaders });
