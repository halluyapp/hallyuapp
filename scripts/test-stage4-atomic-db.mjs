import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
test('snapshot-bound approval execution locks, revalidates, consumes and mutates atomically',async()=>{
 const db=new PGlite();const actor='10000000-0000-4000-8000-000000000001',task='20000000-0000-4000-8000-000000000001',approval='30000000-0000-4000-8000-000000000001',post='40000000-0000-4000-8000-000000000001';
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create table profiles(id uuid primary key,role text,account_status text,is_ai boolean default false,is_banned boolean default false,suspended_until timestamptz,auth_sub text);
 create table posts(id uuid primary key,author_id uuid,body text,title text,state text,visibility text,type text);
 create table comments(id uuid,author_id uuid,post_id uuid,body text,state text);
 create table moderation_actions(id uuid,target_type text,target_id uuid,action text);
 create table operator_campaign(id uuid,version integer,status text,name text,timezone text);
 create table operator_tool(name text primary key,enabled boolean default true,description text,family text,input_schema jsonb,permission text,read_only boolean,approval_required boolean,rate_limit_per_min integer,timeout_ms integer);
 create table operator_task(id uuid primary key,status text,input jsonb default '{}',available_at timestamptz,updated_at timestamptz,lease_owner text,lease_expires_at timestamptz,attempt_count integer default 1);
 create table operator_approval(id uuid primary key,task_id uuid,action text,status text,decided_by uuid,decided_at timestamptz,note text,payload jsonb);
 create table audit(action text,details jsonb);
 create function current_profile_id() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function is_admin() returns boolean language sql as $$select exists(select 1 from profiles where id=current_profile_id() and role='admin' and account_status='active')$$;
 create function operator_require_service() returns void language plpgsql as $$begin if current_setting('test.service',true) is distinct from 'yes' then raise exception 'service required';end if;end$$;
 create function operator_staff_profile_id() returns uuid language sql as $$select current_profile_id()$$;
 create function operator_audit_write(text,text,uuid,uuid,text,text,text,jsonb) returns void language sql as $$insert into audit values($1,$8)$$;
 `);
 for(const f of ['20261125000001_101_single_use_approvals.sql','20261125000002_102_approval_execution_lease.sql','20261125000005_105_atomic_approved_tools.sql'])await db.exec(readFileSync('supabase/migrations/'+f,'utf8'));
 await db.query(`insert into profiles(id,role,account_status) values($1,'admin','active')`,[actor]);
 await db.query(`select set_config('test.actor',$1,false),set_config('test.service','yes',false)`,[actor]);
 await db.query(`insert into posts values($1,$2,'Original','Title','active','public','post')`,[post,actor]);
 const args={post_id:post,body:'Approved exact replacement'};
 await db.query(`insert into operator_task(id,status) values($1,'awaiting_approval')`,[task]);
 await db.query(`insert into operator_approval(id,task_id,action,status,payload) values($1,$2,'post.edit','pending',$3)`,[approval,task,JSON.stringify({tool:'post.edit',arguments:JSON.stringify(args)})]);
 assert.equal((await db.query(`select payload->'target_snapshot'->>'body' body from operator_approval`)).rows[0].body,'Original');
 await assert.rejects(db.exec(`update operator_approval set payload='{}'`),/immutable/);
 await db.query(`select operator_decide_approval($1,'approved',null)`,[approval]);
 await db.exec(`update operator_task set status='executing',lease_owner='fixture',lease_expires_at=now()+interval '2 minutes';update posts set body='Changed after proposal';`);
 const execute=()=>db.query(`select operator_execute_approved($1,$2,'post.edit',$3) r`,[approval,task,JSON.stringify(args)]);
 await assert.rejects(execute(),/approval changed/);
 assert.equal((await db.query(`select consumed_at from operator_approval`)).rows[0].consumed_at,null);
 await db.exec(`update posts set body='Original'`);
 assert.equal((await execute()).rows[0].r.verified,true);
 assert.equal((await db.query(`select body from posts`)).rows[0].body,args.body);
 await assert.rejects(execute(),/approval changed/);
 assert.ok((await db.query(`select consumed_at from operator_approval`)).rows[0].consumed_at);
 assert.equal((await db.query(`select count(*)::int n from audit where action='approved_action.executed'`)).rows[0].n,1);
 // Changing the target back cannot reuse a consumed approval.
 await db.exec(`update posts set body='Original'`);await assert.rejects(execute(),/approval changed/);
 assert.equal((await db.query(`select has_function_privilege('service_role','operator_consume_approval_lease_v102(uuid,uuid,text,jsonb)','execute') a`)).rows[0].a,false);
 assert.equal((await db.query(`select has_function_privilege('authenticated','operator_execute_approved(uuid,uuid,text,jsonb)','execute') a`)).rows[0].a,false);
 }finally{await db.close();}
});
