import { ensureBackendSessionToken, supabase } from './client';
export interface NariPreference { key: string; value: string; source: string; updated_at: string; expires_at: string }
export interface KnowledgeRevision { version: number; title: string; body: string; source_url: string | null; visibility: string; created_at: string; is_active: boolean }
export interface KnowledgeEntry { slug: string; title: string; body: string; source_url: string | null; visibility: 'public' | 'staff'; tags: string[]; version: number; is_active: boolean }
async function session() {
  if (!supabase || !(await ensureBackendSessionToken())) throw new Error('Sign in to manage Nari intelligence.');
  return supabase;
}
export const intelligenceApi = {
  memory: async (key: string | null = null, value: string | null = null, remove = false): Promise<NariPreference[]> => {
    const client = await session();
    const { data, error } = await client.rpc('operator_my_memory', { p_key: key, p_value: value, p_delete: remove });
    if (error) throw new Error(error.message);
    return (data ?? []) as NariPreference[];
  },
  knowledge: async (): Promise<KnowledgeEntry[]> => {
    const client = await session();
    const { data, error } = await client.from('operator_knowledge').select('slug,title,body,source_url,visibility,tags,version,is_active').order('slug');
    if (error) throw new Error(error.message);
    return (data ?? []) as KnowledgeEntry[];
  },
  knowledgeHistory: async (slug: string): Promise<KnowledgeRevision[]> => {
    const client = await session();
    const entry = await client.from('operator_knowledge').select('id').eq('slug', slug).maybeSingle();
    if (entry.error) throw new Error(entry.error.message);
    if (!entry.data) return [];
    const { data, error } = await client.from('operator_knowledge_revision').select('version,title,body,source_url,visibility,created_at,is_active')
      .eq('knowledge_id', entry.data.id).order('version', { ascending: false }).limit(20);
    if (error) throw new Error(error.message);
    return (data ?? []) as KnowledgeRevision[];
  },
  saveKnowledge: async (entry: KnowledgeEntry): Promise<number> => {
    const client = await session();
    const { data, error } = await client.rpc('operator_knowledge_edit', {
      p_slug: entry.slug, p_title: entry.title, p_body: entry.body, p_source_url: entry.source_url || null,
      p_visibility: entry.visibility, p_tags: entry.tags, p_expected_version: entry.version, p_active: entry.is_active,
    });
    if (error) throw new Error(error.message);
    return data as number;
  },
  activeConstitution: async (): Promise<{ version: string; body: string } | null> => {
    const client = await session();
    const { data, error } = await client.from('operator_constitution').select('version,body').eq('is_active', true).maybeSingle();
    if (error) throw new Error(error.message);
    return data as { version: string; body: string } | null;
  },
  publishConstitution: async (version: string, body: string): Promise<string> => {
    const client = await session();
    const { data, error } = await client.rpc('operator_constitution_publish', { p_version: version, p_body: body });
    if (error) throw new Error(error.message);
    return data as string;
  },
};
