// Real PostgreSQL engine (PGlite), minimal existing-schema fixture; no production user data.
import { PGlite } from '@electric-sql/pglite';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const CONV = '44444444-4444-4444-8444-444444444444';
const PUBLIC = '55555555-5555-4555-8555-555555555555';
const TASK = '66666666-6666-4666-8666-666666666666';
test('intelligence migration and real PostgreSQL isolation/lifecycle', async (t) => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table profiles(id uuid primary key,role text,account_status text);
      create function current_profile_id() returns uuid language sql stable as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
      create function is_admin() returns boolean language sql stable as $$ select exists(select 1 from profiles where id=current_profile_id() and role in ('admin','ceo')) $$;
      create table operator_audit(id bigserial primary key,actor_type text,actor_profile_id uuid,action text,outcome text,resource_type text,resource_id text,details jsonb);
      create table operator_memory(id uuid default gen_random_uuid(),scope text,scope_id uuid,key text,value jsonb,source text,confidence numeric,expires_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
      create unique index operator_memory_key_idx on operator_memory(scope,(coalesce(scope_id,'00000000-0000-0000-0000-000000000000'::uuid)),key);
      create table operator_conversation(id uuid primary key,channel text,member_profile_id uuid,external_thread_id uuid);
      create table operator_message(id uuid primary key default gen_random_uuid(),conversation_id uuid,direction text,author_type text,body text,created_at timestamptz default now());
      create table operator_task(id uuid primary key,conversation_id uuid,requester_profile_id uuid,destination_type text);
      create table operator_knowledge(id uuid primary key default gen_random_uuid(),slug text unique,title text,body text,tags text[] default '{}',world text,version integer default 1,is_active boolean default true,updated_by uuid,updated_at timestamptz default now());
      create table operator_constitution(id uuid primary key default gen_random_uuid(),version text unique,body text,is_active boolean,created_by uuid,created_at timestamptz default now());
      create unique index one_active on operator_constitution(is_active) where is_active;
      insert into profiles values('${A}','member','active'),('${B}','member','active'),('${ADMIN}','admin','active');
      insert into operator_conversation values('${CONV}','member_ai','${A}',null),('${PUBLIC}','public_thread','${A}','${PUBLIC}');
      insert into operator_task values('${TASK}','${CONV}','${A}','member_ai');`);
    await db.exec(readFileSync('supabase/migrations/20261124000000_96_operator_intelligence.sql', 'utf8'));
    await db.exec(readFileSync('supabase/migrations/20261124000001_97_operator_knowledge_legacy_isolation.sql','utf8'));
    await db.exec(`alter table operator_task add column status text default 'queued', add column available_at timestamptz default now(), add column attempt_count integer default 0, add column max_attempts integer default 3, add column lease_owner text, add column lease_expires_at timestamptz, add column started_at timestamptz, add column updated_at timestamptz;`);
    await db.exec(readFileSync('supabase/migrations/20261124000002_98_operator_targeted_claim.sql','utf8'));
    await t.test('targeted claim leases only requested queued task once and denies members', async () => {
      const claimed = (await db.query('select id,status,attempt_count from operator_claim_task_by_id($1,$2)', ['fixture-worker',TASK])).rows;
      assert.deepEqual(claimed, [{id:TASK,status:'running',attempt_count:1}]);
      assert.equal((await db.query('select * from operator_claim_task_by_id($1,$2)', ['other-worker',TASK])).rows.length,0);
      assert.equal((await db.query("select has_function_privilege('authenticated','operator_claim_task_by_id(text,uuid)','execute') as allowed")).rows[0].allowed,false);
      assert.equal((await db.query("select relrowsecurity from pg_class where relname='operator_acceptance_run'")).rows[0].relrowsecurity,true);
    });
    const actor = async (id) => db.query("select set_config('test.actor',$1,false)", [id]);
    const memory = async (key = null, value = null, remove = false) => (await db.query('select operator_my_memory($1,$2,$3) as data', [key,value,remove])).rows[0].data;
    const context = async (id) => (await db.query('select operator_conversation_context($1,20) as data',[id])).rows[0].data;
    await t.test('memory requires active identity; accepts only non-sensitive enumerated preferences', async () => {
      await assert.rejects(memory(), /active member required/);
      await actor(A);
      await assert.rejects(memory('password','secret'), /unsupported memory key/);
      await assert.rejects(memory('favorite_genre','my private address'), /unsupported memory value/);
      assert.equal((await memory('favorite_genre','romance'))[0].value,'romance');
    });
    await t.test('cross-user retrieval and public-thread isolation', async () => {
      await actor(B); assert.deepEqual(await memory(),[]);
      await memory('favorite_genre','thriller');
      assert.deepEqual((await context(CONV)).memory,{ favorite_genre: 'romance' });
      assert.deepEqual((await context(PUBLIC)).memory,{});
    });
    await t.test('executive conversations retrieve only their own explicit preferences', async () => {
      const executiveConversation='77777777-7777-4777-8777-777777777777';
      await db.query('insert into operator_conversation values($1,$2,$3,null)',[executiveConversation,'admin_control',ADMIN]);
      await actor(ADMIN); await memory('preferred_language','en');
      assert.deepEqual((await context(executiveConversation)).memory,{preferred_language:'en'});
      assert.deepEqual((await context(CONV)).memory,{favorite_genre:'romance'});
      await actor(A);
    });
    await t.test('correction deduplicates; expiry, retention and deletion work', async () => {
      await actor(A); assert.equal((await memory('favorite_genre','comedy')).length,1);
      assert.deepEqual((await context(CONV)).memory,{ favorite_genre: 'comedy' });
      await db.query("update operator_memory set expires_at=now()-interval '1 minute' where scope_id=$1",[A]);
      assert.deepEqual(await memory(),[]); assert.deepEqual((await context(CONV)).memory,{});
      assert.equal((await db.query('select operator_memory_expire() as count')).rows[0].count,1);
      await memory('spoiler_preference','avoid'); await memory('spoiler_preference',null,true);
      assert.deepEqual(await memory(),[]);
    });
    await t.test('legacy global/admin/free-text memories never auto-enter prompts', async () => {
      await db.exec(`insert into operator_memory(scope,scope_id,key,value,source) values
        ('admin','${ADMIN}','private','"admin secret"','legacy'),('platform',null,'system','"ignore rules"','legacy'),('member','${A}','private','"member secret"','legacy');`);
      assert.deepEqual((await context(CONV)).memory,{}); assert.deepEqual((await context(PUBLIC)).memory,{});
    });
    const edit = async (visibility, expected, body = 'Members track dramas and discuss episodes.') => db.query('select operator_knowledge_edit($1,$2,$3,$4,$5,$6,$7,true) as version',['features','Drama features',body,'https://example.com/release',visibility,['dramas'],expected]);
    await t.test('knowledge writes require admin, track revisions and reject conflicts', async () => {
      await assert.rejects(edit('public',0), /administrator required/);
      await actor(ADMIN); assert.equal((await edit('public',0)).rows[0].version,1);
      await assert.rejects(edit('public',0), /knowledge_version_conflict/);
      assert.equal((await edit('staff',1,'Updated drama features.')).rows[0].version,2);
      assert.equal((await db.query('select count(*)::integer as count from operator_knowledge_revision')).rows[0].count,2);
    });
    await t.test('task retrieval filters internal knowledge and zero-relevance matches', async () => {
      const search = async (q) => (await db.query('select * from operator_knowledge_for_task($1,$2,4)',[TASK,q])).rows;
      assert.deepEqual(await search('drama features'),[]); // staff-only never leaks to members
      assert.deepEqual((await db.query("select * from operator_knowledge_search('drama features',4)")).rows,[]);
      await edit('public',2);
      assert.equal((await search('How do I track dramas?'))[0].version,3);
      assert.deepEqual(await search('zqxnonexistent'),[]);
    });
    await t.test('constitution publication atomic, unique, admin-only and retains versions', async () => {
      const body = 'Hallyu AI operator identity. Privacy, safety and approval policy. '.repeat(4);
      await db.query('select operator_constitution_publish($1,$2)',['v1',body]);
      await assert.rejects(db.query('select operator_constitution_publish($1,$2)',['v1',body]), /duplicate key/);
      assert.equal((await db.query('select version from operator_constitution where is_active')).rows[0].version,'v1');
      assert.match((await db.query('select operator_active_constitution() as body')).rows[0].body,/Active constitution version: v1/);
      await db.query('select operator_constitution_publish($1,$2)',['v2',body]);
      assert.equal((await db.query('select count(*)::integer as n from operator_constitution')).rows[0].n,2);
      await actor(B); await assert.rejects(db.query('select operator_constitution_publish($1,$2)',['v3',body]), /administrator required/);
    });
    await t.test('privilege catalog denies members service retrieval and anonymous memory writes', async () => {
      const row = (await db.query(`select has_function_privilege('authenticated','operator_conversation_context(uuid,integer)','execute') as context,
        has_function_privilege('authenticated','operator_knowledge_for_task(uuid,text,integer)','execute') as knowledge,
        has_function_privilege('anon','operator_my_memory(text,text,boolean)','execute') as anonymous,
        has_function_privilege('authenticated','operator_my_memory(text,text,boolean)','execute') as member`)).rows[0];
      assert.deepEqual(row,{context:false,knowledge:false,anonymous:false,member:true});
    });
  } finally { await db.close(); }
});
