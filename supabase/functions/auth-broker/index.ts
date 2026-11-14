// auth-broker — the web relay for Rork Auth (api.rork.com).
//
// Browsers only send cross-origin calls to hosts that answer CORS for the calling origin.
// api.rork.com allowlists rork.com and *.rork.app, so from any other origin — GitHub Pages,
// localhost, a custom domain — every direct /oauth/* call is blocked before it leaves the page.
// Native apps never hit this. This function performs the same three calls server-to-server,
// where no CORS exists, and returns Rork's JSON and status code unchanged.
//
// It is a fixed relay, not an open one: the destination is one of exactly three api.rork.com
// endpoints, no credentials are added, and Rork's own app-key rejections pass through untouched.

import { corsHeaders, errorResponse } from '../_shared/cors.ts';

const RORK_AUTH_URL = 'https://api.rork.com';

const UPSTREAM: Record<string, string> = {
  initiate: `${RORK_AUTH_URL}/oauth/initiate`,
  token: `${RORK_AUTH_URL}/oauth/token`,
  refresh: `${RORK_AUTH_URL}/oauth/refresh`,
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return errorResponse('POST only', 405);

  const action = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';
  const upstream = UPSTREAM[action];
  if (!upstream) {
    return errorResponse(`Unknown auth action "${action}" — expected initiate, token or refresh`, 404);
  }

  let body: string;
  try {
    body = await req.text();
    // Shape-check before forwarding: all three Rork calls are JSON objects.
    JSON.parse(body);
  } catch {
    return errorResponse('A JSON request body is required', 400);
  }

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (e) {
    return errorResponse(`Rork Auth could not be reached: ${e instanceof Error ? e.message : String(e)}`, 502);
  }

  const text = await upstreamRes.text();
  return new Response(text, {
    status: upstreamRes.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
