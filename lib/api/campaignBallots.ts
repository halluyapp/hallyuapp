import { ensureBackendSessionToken, supabase } from './client';
import { campaignTimestamp } from './campaigns';
export interface BallotProposal {campaign:string;version:number;key:string;question:string;options:string[];closes:string;month:string;}
export interface CampaignReport {
 campaign_id:string;status:string;post_id:string|null;ballot_month:string|null;closes_at:string|null;
 announcement_counts:Record<string,number>;ballot_options:{option:string;votes:number}[]|null;
 total_votes:number;comments:number;measured_at:string;limitation:string;
}
async function client(){if(!supabase||!(await ensureBackendSessionToken()))throw new Error('Sign in to manage voting.');return supabase;}
export const campaignBallotsApi={
 async launch(p:BallotProposal){
  const db=await client();const closes=campaignTimestamp(p.closes);if(!closes)throw new Error('Closing time required');
  if(p.month&&!/^\d{4}-\d{2}-01$/.test(p.month))throw new Error('Month must be YYYY-MM-01');
  const {data,error}=await db.rpc('operator_campaign_ballot_launch',{p_campaign:p.campaign,p_version:p.version,p_key:p.key,p_question:p.question,p_options:p.options,p_closes:closes,p_month:p.month||null});
  if(error)throw new Error(error.message);if(!data?.verified||!data?.post_id)throw new Error('Ballot not verified; refresh before retrying.');return data;
 },
 async finish(id:string,version:number,cancel:boolean){const db=await client();const {data,error}=await db.rpc('operator_campaign_finish',{p_campaign:id,p_version:version,p_cancel:cancel});if(error)throw new Error(error.message);if(!data?.verified)throw new Error('Campaign completion unverified');},
 async report(id:string):Promise<CampaignReport>{const db=await client();const {data,error}=await db.rpc('operator_campaign_report',{p_campaign:id});if(error)throw new Error(error.message);if(!data?.campaign_id)throw new Error('Campaign report unavailable');return data as CampaignReport;},
};
