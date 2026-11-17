import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

test('campaign announcement exact SQL: approval, recurrence, replay, revocation and atomic publication',async()=>{
  const db=new PGlite();
  const actor='10000000-0000-4000-8000-000000000001';
  const campaign='20000000-0000-4000-8000-000000000001';
  const series='30000000-0000-4000-8000-000000000001';
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create schema cron;
      create function cron.schedule(text,text,text) returns integer language sql as $$select 1$$;
      create table profiles(id uuid primary key,role text,account_status text);
      create table operator_campaign(id uuid primary key,status text,version integer,updated_at timestamptz);
      create table posts(id uuid primary key default gen_random_uuid(),author_id uuid,body text,type text,visibility text,state text);
      create table audit(action text,resource_id text);
      create function current_profile_id() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
      create function is_admin() returns boolean language sql security definer as $$select exists(select 1 from profiles where id=current_profile_id() and role in ('admin','ceo') and account_status='active')$$;
      create function operator_audit_write(text,text,uuid,uuid,text,text,text,jsonb) returns void language sql as $$insert into audit values($1,$7)$$;
    `);
    await db.exec(readFileSync('supabase/migrations/20261125000003_103_campaign_announcements.sql','utf8'));
    await db.query(`insert into profiles values($1,'admin','active');`,[actor]);
    await db.query(`insert into operator_campaign values($1,'draft',1,now())`,[campaign]);
    await db.query(`select set_config('test.actor',$1,false)`,[actor]);
    const schedule=async(overrides={})=>{
      const p={campaign,version:1,series,body:'Exact public announcement',at:'2027-03-13T14:00:00Z',tz:'America/New_York',repeat:1,count:3,...overrides};
      return (await db.query(`select operator_campaign_schedule($1,$2,$3,$4,$5,$6,$7,$8) as result`,[p.campaign,p.version,p.series,p.body,p.at,p.tz,p.repeat,p.count])).rows[0].result;
    };
    // Relative instants keep schedule validation independent of the test runner's date.
    const at=new Date(Date.now()+3600_000).toISOString();
    await db.exec(`update profiles set role='member'`);
    await assert.rejects(schedule({at}),/admin role required/);
    await db.exec(`update profiles set role='admin'`);
    await assert.rejects(schedule({at,tz:'Invalid/Timezone'}),/invalid announcement/);
    await assert.rejects(schedule({at,version:99}),/campaign changed/);
    assert.equal((await schedule({at})).occurrences,3);
    assert.equal((await schedule({at})).duplicate,true);
    await assert.rejects(schedule({at,body:'Changed content'}),/different content/);
    assert.equal((await db.query(`select count(*)::int n from operator_campaign_action`)).rows[0].n,3);
    assert.equal((await db.query(`select has_function_privilege('authenticated','operator_campaign_action_sweep()','execute') allowed`)).rows[0].allowed,false);
    assert.equal((await db.query(`select has_table_privilege('authenticated','operator_campaign_action','insert') allowed`)).rows[0].allowed,false);
    const ids=(await db.query(`select id from operator_campaign_action order by occurrence`)).rows.map(r=>r.id);
    await db.exec(`update profiles set role='member'`);
    await assert.rejects(db.query(`select operator_campaign_action_cancel($1)`,[ids[2]]),/admin role required/);
    await db.exec(`set role authenticated`);
    assert.equal((await db.query(`select count(*)::int n from operator_campaign_action`)).rows[0].n,0);
    await db.exec(`reset role; update profiles set role='admin'`);
    await db.query(`select operator_campaign_action_cancel($1)`,[ids[2]]);
    await db.query(`select operator_campaign_action_cancel($1)`,[ids[2]]);
    await db.query(`update operator_campaign_action set run_at=now()-interval '1 minute' where id=$1`,[ids[0]]);
    assert.equal((await db.query(`select operator_campaign_action_sweep() n`)).rows[0].n,1);
    assert.equal((await db.query(`select body from posts`)).rows[0].body,'Exact public announcement');
    assert.equal((await db.query(`select operator_campaign_action_sweep() n`)).rows[0].n,0);
    await db.exec(`update profiles set role='member'; update operator_campaign_action set run_at=now()-interval '1 minute' where status='scheduled'`);
    await db.query(`select operator_campaign_action_sweep()`);
    assert.equal((await db.query(`select status from operator_campaign_action where occurrence=1`)).rows[0].status,'blocked');
    assert.equal((await db.query(`select count(*)::int n from posts`)).rows[0].n,1);
    // Reset only isolated fixtures for failure/missed/campaign revocation cases.
    await db.exec(`delete from operator_campaign_action; delete from posts; update profiles set role='admin'; update operator_campaign set status='draft',version=1`);
    await schedule({at,count:1,repeat:0});
    await db.exec(`update operator_campaign_action set run_at=now()-interval '25 hours'`);
    await db.query(`select operator_campaign_action_sweep()`);
    assert.equal((await db.query(`select status from operator_campaign_action`)).rows[0].status,'missed');
    await db.exec(`delete from operator_campaign_action; update operator_campaign set status='draft',version=1`);
    await schedule({at,count:1,repeat:0});
    await db.exec(`update operator_campaign_action set run_at=now()-interval '1 minute'; update operator_campaign set status='cancelled'`);
    await db.query(`select operator_campaign_action_sweep()`);
    assert.equal((await db.query(`select status from operator_campaign_action`)).rows[0].status,'blocked');
    await db.exec(`delete from operator_campaign_action; update operator_campaign set status='draft',version=1`);
    await schedule({at,count:1,repeat:0});
    await db.exec(`update operator_campaign_action set run_at=now()-interval '1 minute';
      create function fail_audit() returns trigger language plpgsql as $$begin if new.action='campaign.announcement.published' then raise exception 'audit failure'; end if; return new; end$$;
      create trigger test_failure before insert on audit for each row execute function fail_audit();`);
    await db.query(`select operator_campaign_action_sweep()`);
    assert.equal((await db.query(`select status from operator_campaign_action`)).rows[0].status,'failed');
    assert.equal((await db.query(`select count(*)::int n from posts`)).rows[0].n,0);
    // PostgreSQL's calendar recurrence changes UTC offset while retaining wall-clock hour.
    const dst=(await db.query(`select ((timestamptz '2027-03-13 14:00Z' at time zone 'America/New_York')+interval '1 day') at time zone 'America/New_York' as due`)).rows[0].due;
    assert.equal(new Date(dst).toISOString(),'2027-03-14T13:00:00.000Z');
  } finally {await db.close();}
});
