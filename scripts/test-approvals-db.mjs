import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
// Isolated PostgreSQL engine with narrow dependency fixtures, not a production availability test.
// The functions under test are the exact forward migration, not translated JavaScript.
test('exact-action approval SQL contracts in isolated PostgreSQL',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table profiles(id uuid primary key,role text,account_status text);
      create table operator_tool(name text primary key,enabled boolean);
      create table operator_task(id uuid primary key,status text,input jsonb default '{}',available_at timestamptz,updated_at timestamptz,lease_owner text,lease_expires_at timestamptz,attempt_count integer default 1);
      create table operator_approval(id uuid primary key,task_id uuid,action text,status text,decided_by uuid,decided_at timestamptz,note text,payload jsonb);
      create table audit(action text,resource_id text);
      create function current_profile_id() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
      create function is_admin() returns boolean language sql as $$select exists(select 1 from profiles where id=current_profile_id() and role in ('admin','ceo') and account_status='active')$$;
      create function operator_require_service() returns void language plpgsql as $$begin if current_setting('test.role',true) is distinct from 'service_role' then raise exception 'service required' using errcode='42501'; end if; end$$;
      create function operator_audit_write(text,text,uuid,uuid,text,text,text,jsonb) returns void language sql as $$insert into audit values($1,$7)$$;
    `);
    await db.exec(readFileSync('supabase/migrations/20261125000001_101_single_use_approvals.sql','utf8'));
    const actor='10000000-0000-4000-8000-000000000001';
    const task='20000000-0000-4000-8000-000000000001';
    const approval='30000000-0000-4000-8000-000000000001';
    await db.query(`insert into profiles values($1,'admin','active')`,[actor]);
    await db.exec(`insert into operator_tool values('post.publish',true)`);
    await db.query(`select set_config('test.actor',$1,false),set_config('test.role','service_role',false)`,[actor]);
    const reset=async()=>{
      await db.exec(`delete from operator_approval; delete from operator_task; update profiles set role='admin',account_status='active'; update operator_tool set enabled=true;`);
      await db.query(`insert into operator_task(id,status) values($1,'awaiting_approval')`,[task]);
      await db.query(`insert into operator_approval(id,task_id,action,status,payload) values($1,$2,'post.publish','pending',$3)`,[approval,task,JSON.stringify({tool:'post.publish',arguments:'{"post_id":"target"}'})]);
    };
    const decide=async(decision='approved')=>(await db.query('select operator_decide_approval($1,$2,null) as result',[approval,decision])).rows[0].result;
    const consume=async(args={post_id:'target'}, action='post.publish',taskId=task)=>(await db.query('select operator_consume_approval($1,$2,$3,$4) as result',[approval,taskId,action,JSON.stringify(args)])).rows[0].result;
    await reset();
    await db.exec(`update profiles set role='member'`);
    await assert.rejects(decide(),/admin role required/);
    await db.exec(`update profiles set role='admin'`);
    assert.equal((await decide()).status,'approved');
    await assert.rejects(decide(),/already decided/);
    assert.equal(await consume(),false); // not leased/running yet
    await db.exec(`update operator_task set status='running'`);
    assert.equal(await consume({post_id:'different'}),false);
    assert.equal(await consume({post_id:'target'},'post.delete'),false);
    assert.equal(await consume({post_id:'target'},'post.publish',actor),false);
    assert.equal((await db.query(`select input->>'_approved_action_id' as id from operator_task`)).rows[0].id,approval);
    const once=await Promise.all([consume(),consume()]);
    assert.deepEqual(once.sort(),[false,true]);
    assert.equal((await db.query(`select count(*)::int as n from audit where action='approval.consumed'`)).rows[0].n,1);
    await reset(); await decide(); await db.exec(`update operator_task set status='running'; update profiles set account_status='suspended'`);
    assert.equal(await consume(),false);
    await db.exec(`update profiles set account_status='active'; update operator_tool set enabled=false`);
    assert.equal(await consume(),false);
    await db.exec(`update operator_tool set enabled=true; update operator_approval set expires_at=now()-interval '1 second'`);
    assert.equal(await consume(),false);
    await reset();await db.exec(`update operator_approval set expires_at=now()-interval '1 second'`);
    assert.equal((await decide()).status,'expired');
    assert.equal((await db.query(`select status from operator_task`)).rows[0].status,'cancelled');
    await reset();assert.equal((await decide('rejected')).status,'rejected');assert.equal(await consume(),false);
    assert.equal((await db.query(`select status from operator_task`)).rows[0].status,'cancelled');
    await reset();await decide();await db.exec(`update operator_task set status='running'; select set_config('test.role','authenticated',false)`);
    await assert.rejects(consume(),/service required/);
    assert.equal((await db.query(`select has_function_privilege('authenticated','operator_consume_approval(uuid,uuid,text,jsonb)','execute') as allowed`)).rows[0].allowed,false);
  } finally {await db.close();}
});
