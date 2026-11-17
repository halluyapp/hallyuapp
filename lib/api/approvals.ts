import { ensureBackendSessionToken, supabase } from './client';
export interface ActionApproval {
  id: string; task_id: string; action: string; status: string; payload: Record<string, unknown>;
  created_at: string; expires_at: string; consumed_at: string | null;
}
async function client() {
  if (!supabase || !(await ensureBackendSessionToken())) throw new Error('Sign in to review approvals.');
  return supabase;
}
export const approvalsApi = {
  async list(): Promise<ActionApproval[]> {
    const db = await client();
    const {data,error} = await db.from('operator_approval')
      .select('id,task_id,action,status,payload,created_at,expires_at,consumed_at').order('created_at',{ascending:false}).limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []) as ActionApproval[];
  },
  async decide(id: string, decision: 'approved' | 'rejected', note: string) {
    const db = await client();
    const {data,error} = await db.rpc('operator_decide_approval',{p_approval:id,p_decision:decision,p_note:note.slice(0,500)});
    if (error) throw new Error(error.message);
    if (!data?.status) throw new Error('No approval decision returned. Refresh before retrying.');
    return String(data.status);
  },
};
