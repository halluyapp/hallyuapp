// Short-lived GitHub OIDC -> fixture-scoped API. Never downloads a service-role/provider key.
const endpoint = 'https://ltyymanoidagwsapgiql.supabase.co/functions/v1/operator-ui-fixture';
export async function fixture(action) {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error('GitHub Actions OIDC is required; no fixture created.');
  const url = new URL(requestUrl);
  url.searchParams.set('audience','hallyu-nari-ui');
  const minted = await fetch(url,{headers:{Authorization:`Bearer ${requestToken}`},signal:AbortSignal.timeout(20000)});
  if(!minted.ok) throw new Error(`OIDC mint failed: HTTP ${minted.status}`);
  const {value} = await minted.json();
  if(!value) throw new Error('OIDC token missing');
  const response = await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${value}`,'Content-Type':'application/json'},body:JSON.stringify({action}),signal:AbortSignal.timeout(60000)});
  const result = await response.json().catch(()=>null);
  if(!response.ok) throw new Error(`Fixture ${action}: HTTP ${response.status} ${String(result?.error ?? 'request_failed')}`);
  return result;
}
if (process.argv[1]?.endsWith('/nari-fixture-client.mjs')) {
  if(process.argv[2]!=='cleanup') throw new Error('Only explicit cleanup supported on the command line');
  console.log(JSON.stringify(await fixture('cleanup')));
}
