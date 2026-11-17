// Explicit opt-in, real deployed UI + existing backend; creates only a temporary fixture member.
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anon = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !anon || !secret) throw new Error('Live browser verification blocked: SUPABASE_SERVICE_ROLE_KEY and client-safe Supabase configuration are required in this GitHub job. No account created.');
const site = 'https://hallyuapp.vercel.app';
const admin = createClient(url, secret, { auth:{persistSession:false,autoRefreshToken:false} });
const tag = crypto.randomUUID().slice(0,8);
const email = `nari.ui.${tag}@example.invalid`;
const password = crypto.randomUUID() + 'Aa7!';
const slug = `nari-ui-${tag}`;
let userId, profileId, browser;
const checks = [];
const unwrap = ({data,error}) => { if(error) throw new Error(error.message); return data; };
try {
  userId = unwrap(await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{full_name:'Nari UI Acceptance',nari_ui_fixture:tag}})).user.id;
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:360,height:800}});
  await page.goto(site + '/sign-in', {waitUntil:'domcontentloaded'});
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in with email',exact:true}).click();
  await page.waitForURL((target)=>!target.pathname.includes('sign-in'),{timeout:60000});
  checks.push('real email sign-in');
  const profile = unwrap(await admin.from('profiles').select('id').eq('auth_sub',userId).single());
  profileId = profile.id;
  await page.goto(site+'/settings/nari-memory');
  await page.getByRole('button',{name:'thriller',exact:true}).click({timeout:60000});
  await page.getByText(/^Saved: thriller/).waitFor();
  await page.reload();
  await page.getByText(/^Saved: thriller/).waitFor({timeout:30000});
  checks.push('saved preference persists after reload');
  await page.getByRole('button',{name:'comedy',exact:true}).click();
  await page.getByText(/^Saved: comedy/).waitFor();
  await page.getByRole('button',{name:'Forget this preference',exact:true}).click();
  await page.getByText(/^Saved: comedy/).waitFor({state:'hidden'});
  assert.equal(unwrap(await admin.from('operator_memory').select('key').eq('scope_id',profileId)).length,0);
  checks.push('preference corrected and deleted via UI');
  await page.goto(site+'/settings/nari-knowledge');
  await page.getByText('Administrator access required.',{exact:true}).waitFor();
  checks.push('member denied knowledge editor');
  unwrap(await admin.from('profiles').update({role:'admin'}).eq('id',profileId));
  await page.reload();
  await page.getByLabel('Unique slug',{exact:true}).fill(slug,{timeout:60000});
  await page.getByLabel('Title',{exact:true}).fill('Nari UI fixture');
  await page.getByLabel('Knowledge body',{exact:true}).fill('Temporary test evidence. No product or publication claims.');
  await page.getByRole('button',{name:'Save knowledge (expected version 0)',exact:true}).click();
  await page.getByText('Revision history (latest 20)',{exact:true}).waitFor();
  await page.getByText(/Saved version 1/).waitFor();
  checks.push('admin saved knowledge and rendered revision history');
  console.log(JSON.stringify({site,checks,status:'pass'}));
} finally {
  if (browser) await browser.close();
  unwrap(await admin.from('operator_knowledge').delete().eq('slug',slug));
  if (profileId) {
    unwrap(await admin.from('operator_memory').delete().eq('scope_id',profileId));
    unwrap(await admin.from('profiles').delete().eq('id',profileId));
  } else if (userId) {
    unwrap(await admin.from('profiles').delete().eq('auth_sub',userId));
  }
  if (userId) unwrap(await admin.auth.admin.deleteUser(userId));
  console.log('Temporary UI fixture cleanup completed.');
}
