import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {PGlite} from '@electric-sql/pglite';
test('exact delivery SQL revalidates preferences, account, blocks, ownership and quiet hours before claiming',async()=>{
 const db=new PGlite();const u='10000000-0000-4000-8000-000000000001',actor='20000000-0000-4000-8000-000000000001';
 try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create type push_platform as enum('android');
 create table profiles(id uuid,account_status text);create table user_preferences(user_id uuid,notify_social boolean default true,notify_system boolean default true,notify_episodes boolean default true,quiet_hours boolean default false);
 create table notifications(id uuid primary key,recipient_id uuid,scheduled_for timestamptz default now(),expires_at timestamptz,actor_ids uuid[],kind text,"group" text,title text,body text,deep_link text,coalesce_count integer,episode smallint,title_id uuid,post_id uuid,comment_id uuid,community_id uuid,collection_id uuid);
 create table push_tokens(id uuid primary key,user_id uuid,token text,platform push_platform,disabled_at timestamptz);
 create table notification_deliveries(id uuid primary key,notification_id uuid,push_token_id uuid,status text default 'queued',next_attempt_at timestamptz default now(),attempt integer default 0,created_at timestamptz default now(),updated_at timestamptz);
 create table blocks(blocker_id uuid,blocked_id uuid);
 create function current_profile_id() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function notify_at_for(uuid,timestamptz) returns timestamptz language sql as $$select case when (select quiet_hours from user_preferences where user_id=$1) then $2+interval '1 hour' else $2 end$$;
 `);
 const sql=readFileSync('supabase/migrations/20261125000006_106_operator_control_status.sql','utf8');await db.exec(sql.slice(sql.indexOf('create or replace function public.claim_notification_deliveries(')));
 await db.query(`insert into profiles values($1,'active')`,[u]);await db.query(`insert into user_preferences(user_id) values($1)`,[u]);
 await db.query(`insert into notifications(id,recipient_id,actor_ids,kind,"group") values($1,$1,array[$2::uuid],'system','system')`,[u,actor]);
 await db.query(`insert into push_tokens values($1,$1,'isolated-not-a-real-token','android',null)`,[u]);
 await db.query(`insert into notification_deliveries(id,notification_id,push_token_id) values($1,$1,$1)`,[u]);
 const claim=()=>db.query(`select * from claim_notification_deliveries(1,5)`);
 assert.equal((await claim()).rows.length,1);assert.equal((await claim()).rows.length,0);
 await db.exec(`update notification_deliveries set status='queued';update user_preferences set notify_system=false`);assert.equal((await claim()).rows.length,0);
 await db.exec(`update user_preferences set notify_system=true,quiet_hours=true`);assert.equal((await claim()).rows.length,0);
 await db.exec(`update user_preferences set quiet_hours=false;update profiles set account_status='suspended'`);assert.equal((await claim()).rows.length,0);
 await db.exec(`update profiles set account_status='active'`);await db.query(`insert into blocks values($1,$2)`,[u,actor]);assert.equal((await claim()).rows.length,0);
 await db.exec(`delete from blocks`);await db.query(`update push_tokens set user_id=$1`,[actor]);assert.equal((await claim()).rows.length,0);
 await db.query(`update push_tokens set user_id=$1`,[u]);assert.equal((await claim()).rows.length,1);
 assert.equal((await db.query(`select attempt from notification_deliveries`)).rows[0].attempt,2);
 await db.query(`select set_config('test.actor',$1,false)`,[u]);await assert.rejects(claim(),/service-role operation/);
 }finally{await db.close();}
});
