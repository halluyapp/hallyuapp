// Shared zero-dependency Supabase PostgREST + Storage admin client for Hallyu Edge Functions.
//
// Service-role credentials come exclusively from the function environment (`SUPABASE_URL`,
// `SUPABASE_SERVICE_ROLE_KEY`) and are never read from the repository or echoed back. Using native
// `fetch` directly against PostgREST and Storage eliminates external registry cold-start imports.

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export interface PostgrestError {
  message: string;
  status?: number;
}

export interface PostgrestResponse<T = unknown> {
  data: T | null;
  count: number | null;
  error: PostgrestError | null;
}

class QueryBuilder<T = Record<string, unknown>> implements PromiseLike<PostgrestResponse<T>> {
  private method: 'GET' | 'HEAD' | 'PATCH' = 'GET';
  private selectCols = '*';
  private wantCount = false;
  private singleRow = false;
  private patchBody: Record<string, unknown> | null = null;
  private filters: [string, string][] = [];

  constructor(private readonly table: string) {}

  select(columns = '*', opts?: { count?: 'exact'; head?: boolean }): this {
    this.selectCols = columns;
    this.wantCount = opts?.count === 'exact';
    if (opts?.head) this.method = 'HEAD';
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.method = 'PATCH';
    this.patchBody = values;
    return this;
  }

  eq(column: string, value: string | number | boolean): this {
    this.filters.push([column, `eq.${value}`]);
    return this;
  }

  in(column: string, values: (string | number)[]): this {
    const encoded = values.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(',');
    this.filters.push([column, `in.(${encoded})`]);
    return this;
  }

  is(column: string, value: null | boolean): this {
    this.filters.push([column, `is.${String(value)}`]);
    return this;
  }

  lt(column: string, value: string | number): this {
    this.filters.push([column, `lt.${value}`]);
    return this;
  }

  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const dir = opts?.ascending === false ? 'desc' : 'asc';
    const nulls =
      opts?.nullsFirst === false ? '.nullslast' : opts?.nullsFirst === true ? '.nullsfirst' : '';
    this.filters.push(['order', `${column}.${dir}${nulls}`]);
    return this;
  }

  limit(n: number): this {
    this.filters.push(['limit', String(n)]);
    return this;
  }

  single(): this {
    this.singleRow = true;
    return this;
  }

  private async execute(): Promise<PostgrestResponse<T>> {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${this.table}`);
    if (this.method !== 'PATCH') {
      url.searchParams.set('select', this.selectCols);
    }
    for (const [k, v] of this.filters) {
      url.searchParams.append(k, v);
    }

    const prefer: string[] = [];
    if (this.wantCount) prefer.push('count=exact');
    if (this.method === 'PATCH') prefer.push('return=minimal');

    const headers: Record<string, string> = {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'x-application-name': 'hallyu-edge',
      Accept: this.singleRow ? 'application/vnd.pgrst.object+json' : 'application/json',
    };
    if (prefer.length > 0) headers.Prefer = prefer.join(',');
    if (this.patchBody !== null) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method: this.method,
      headers,
      body: this.patchBody !== null ? JSON.stringify(this.patchBody) : undefined,
    });

    const contentRange = res.headers.get('content-range');
    let count: number | null = null;
    if (contentRange && contentRange.includes('/')) {
      const parsed = Number(contentRange.split('/')[1]);
      if (Number.isFinite(parsed)) count = parsed;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { data: null, count, error: { message: text.slice(0, 300) || `HTTP ${res.status}`, status: res.status } };
    }

    if (this.method === 'HEAD' || res.status === 204) {
      return { data: null, count, error: null };
    }

    const text = await res.text();
    const data = (text ? JSON.parse(text) : null) as T;
    return { data, count, error: null };
  }

  then<TResult1 = PostgrestResponse<T>, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResponse<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

export interface AdminClient {
  rpc<T = unknown>(fn: string, params?: Record<string, unknown>): Promise<{ data: T | null; error: PostgrestError | null }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from<T = any>(table: string): QueryBuilder<T>;
  storage: {
    from(bucket: string): {
      remove(paths: string[]): Promise<{ data: unknown; error: PostgrestError | null }>;
    };
  };
}

export function adminClient(): AdminClient {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as function secrets');
  }

  return {
    async rpc<T = unknown>(fn: string, params: Record<string, unknown> = {}) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'x-application-name': 'hallyu-edge',
        },
        body: JSON.stringify(params),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { data: null, error: { message: text.slice(0, 300) || `HTTP ${res.status}`, status: res.status } };
      }

      const text = await res.text();
      return { data: (text ? JSON.parse(text) : null) as T, error: null };
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    from<T = any>(table: string) {
      return new QueryBuilder<T>(table);
    },

    storage: {
      from(bucket: string) {
        return {
          async remove(paths: string[]) {
            const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}`, {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json',
                apikey: SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
                'x-application-name': 'hallyu-edge',
              },
              body: JSON.stringify({ prefixes: paths }),
            });
            if (!res.ok) {
              const text = await res.text().catch(() => '');
              return { data: null, error: { message: text.slice(0, 300) || `HTTP ${res.status}`, status: res.status } };
            }
            const text = await res.text();
            return { data: text ? JSON.parse(text) : [], error: null };
          },
        };
      },
    },
  };
}

export function requireServiceRole(request: Request): { ok: true } | { ok: false; response: Response } {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  if (!token || token !== SERVICE_ROLE_KEY) {
    return { ok: false, response: new Response(JSON.stringify({ error: 'service role required' }), { status: 401 }) };
  }

  return { ok: true };
}
