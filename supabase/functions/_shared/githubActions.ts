// Minimal GitHub Actions OIDC verification without a registry dependency. The release worker must
// never accept a user JWT, the CI gateway secret, or a service-role bearer as maintenance authority.

export interface GitHubActionsIdentity {
  repository: string;
  ref: string;
  workflow: string;
  runId: string;
}

function decodeJsonPart(value: string, label: string): Record<string, unknown> {
  try {
    const json = new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`invalid GitHub OIDC ${label}`);
  }
}

async function jwks(issuer: string): Promise<JsonWebKey[]> {
  const response = await fetch(`${issuer}/.well-known/jwks`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('GitHub OIDC key service is unavailable');
  const body = await response.json() as { keys?: JsonWebKey[] };
  if (!Array.isArray(body.keys)) throw new Error('GitHub OIDC returned no keys');
  return body.keys;
}

/** Verify RS256 against the published JWK selected by the unverified header's key id. */
export async function verifyGitHubActionsToken(token: string, repository: string): Promise<GitHubActionsIdentity> {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || token.split('.').length !== 3) throw new Error('invalid GitHub OIDC token');
  const header = decodeJsonPart(encodedHeader, 'header');
  const payload = decodeJsonPart(encodedPayload, 'payload');
  const issuer = 'https://token.actions.githubusercontent.com';
  const audience = Deno.env.get('GITHUB_ACTIONS_OIDC_AUDIENCE') ?? 'hallyu-release-maintenance';
  const requiredRef = Deno.env.get('GITHUB_RELEASE_REF');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('invalid GitHub OIDC algorithm');
  if (payload.iss !== issuer || payload.repository !== repository || !['push', 'workflow_dispatch'].includes(String(payload.event_name))) {
    throw new Error('GitHub OIDC issuer, repository, or event is not authorized');
  }
  if (typeof payload.ref !== 'string' || !payload.ref.startsWith('refs/heads/') || (requiredRef && payload.ref !== requiredRef)) {
    throw new Error('GitHub OIDC branch is not authorized for release maintenance');
  }
  if (payload.job_workflow_ref !== `${repository}/.github/workflows/build-apk.yml@${payload.ref}`) {
    throw new Error('GitHub OIDC workflow is not the APK publisher');
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) throw new Error('invalid GitHub OIDC audience');
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || typeof payload.nbf !== 'number' || payload.exp <= now || payload.nbf > now + 60) {
    throw new Error('GitHub OIDC token is expired or not yet valid');
  }
  const key = (await jwks(issuer)).find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
  if (!key) throw new Error('GitHub OIDC signing key was not found');
  const cryptoKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(atob(encodedSignature.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
  if (!valid) throw new Error('invalid GitHub OIDC signature');
  return { repository, ref: payload.ref, workflow: payload.job_workflow_ref, runId: String(payload.run_id ?? '') };
}
