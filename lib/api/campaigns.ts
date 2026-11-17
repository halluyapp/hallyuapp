import { ensureBackendSessionToken, supabase } from './client';
export interface CampaignDraft {
  id: string | null; version: number; name: string; kind: 'campaign' | 'event' | 'poll' | 'vote';
  description: string; objective: string; timezone: string; starts_at: string | null; ends_at: string | null;
  status: string;
}
async function client() {
  if (!supabase || !(await ensureBackendSessionToken())) throw new Error('Sign in to manage campaigns.');
  return supabase;
}
export function campaignTimestamp(value: string): string | null {
  if (!value.trim()) return null;
  // Require an explicit offset: parsing local wall time silently is unsafe across devices and DST.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Use an ISO date with timezone offset, e.g. 2026-12-01T18:00:00+01:00.');
  }
  return new Date(value).toISOString();
}
export const campaignsApi = {
  async list(): Promise<CampaignDraft[]> {
    const db = await client();
    const { data, error } = await db.from('operator_campaign')
      .select('id,version,name,kind,description,objective,timezone,starts_at,ends_at,status').order('updated_at', { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []) as CampaignDraft[];
  },
  async save(entry: CampaignDraft): Promise<CampaignDraft> {
    const db = await client();
    const { data, error } = await db.rpc('operator_campaign_save', {
      p_id: entry.id, p_expected_version: entry.version, p_name: entry.name, p_kind: entry.kind,
      p_description: entry.description, p_objective: entry.objective, p_timezone: entry.timezone,
      p_starts_at: campaignTimestamp(entry.starts_at ?? ''), p_ends_at: campaignTimestamp(entry.ends_at ?? ''), p_status: entry.status,
    });
    if (error) throw new Error(error.message);
    if (!data?.id || !data?.version) throw new Error('Campaign save returned no verified record. Refresh before retrying.');
    return data as CampaignDraft;
  },
};
