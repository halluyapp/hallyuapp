import { ensureBackendSessionToken, supabase } from './client';
import { campaignTimestamp } from './campaigns';
export interface CampaignAction {
  id: string; campaign_id: string; series_id: string; occurrence: number; repeat_days: number;
  body: string; timezone: string; run_at: string; status: string; post_id: string | null;
  finished_at: string | null; error_code: string | null;
}
export interface ScheduleProposal {
  campaign: string; version: number; key: string; body: string; at: string;
  timezone: string; repeatDays: number; count: number;
}
async function client() {
  if (!supabase || !(await ensureBackendSessionToken())) throw new Error('Sign in to schedule campaign announcements.');
  return supabase;
}
export const campaignScheduleApi = {
  async list(campaign: string): Promise<CampaignAction[]> {
    const db=await client();
    const {data,error}=await db.from('operator_campaign_action')
      .select('id,campaign_id,series_id,occurrence,repeat_days,body,timezone,run_at,status,post_id,finished_at,error_code')
      .eq('campaign_id',campaign).order('run_at',{ascending:false}).limit(100);
    if(error) throw new Error(error.message);
    return (data??[]) as CampaignAction[];
  },
  async schedule(proposal: ScheduleProposal) {
    if (!Number.isInteger(proposal.count) || proposal.count<1 || proposal.count>31) throw new Error('Choose 1–31 occurrences.');
    const at=campaignTimestamp(proposal.at);
    if(!at) throw new Error('A scheduled time is required.');
    const db=await client();
    const {data,error}=await db.rpc('operator_campaign_schedule',{
      p_campaign:proposal.campaign,p_expected_version:proposal.version,p_series:proposal.key,
      p_body:proposal.body,p_at:at,p_timezone:proposal.timezone,p_repeat_days:proposal.repeatDays,p_count:proposal.count,
    });
    if(error) throw new Error(error.message);
    if(!data?.series_id || !Number.isInteger(data?.occurrences)) throw new Error('No verified schedule returned. Retry the same proposal or refresh history.');
    return data as {series_id:string;occurrences:number;duplicate:boolean};
  },
  async cancel(action: string) {
    const db=await client();
    const {data,error}=await db.rpc('operator_campaign_action_cancel',{p_action:action});
    if(error) throw new Error(error.message);
    if(data?.status!=='cancelled') throw new Error('Cancellation was not verified. Refresh history.');
  },
};
