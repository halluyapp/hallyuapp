// Explicit opt-in, real deployed UI + existing backend; creates only a temporary fixture member.
import { fixture } from './nari-fixture-client.mjs';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const site = 'https://hallyuapp.vercel.app';
let browser, email = '', password = '', slug = '';
const checks = [];
try {
  ({email,password,slug} = await fixture('create'));
  // Suppress fixture credentials in every subsequent GitHub log line.
  console.log(`::add-mask::${email}`);
  console.log(`::add-mask::${password}`);
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:360,height:800}});
  await page.goto(site + '/sign-in', {waitUntil:'domcontentloaded'});
  await page.getByLabel('Email',{exact:true}).fill(email);
  await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Sign in with email',exact:true}).click();
  await page.waitForURL((target)=>!target.pathname.includes('sign-in'),{timeout:60000});
  checks.push('real email sign-in');
  assert.ok((await fixture('inspect')).profile_id);
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
  assert.equal((await fixture('inspect')).memory_count,0);
  checks.push('preference corrected and deleted via UI');
  await page.goto(site+'/settings/nari-knowledge');
  await page.getByText('Administrator access required.',{exact:true}).waitFor();
  checks.push('member denied knowledge editor');
  await fixture('promote');
  await page.reload();
  await page.getByLabel('Unique slug',{exact:true}).fill(slug,{timeout:60000});
  await page.getByLabel('Title',{exact:true}).fill('Nari UI fixture');
  await page.getByLabel('Knowledge body',{exact:true}).fill('Temporary test evidence. No product or publication claims.');
  await page.getByRole('button',{name:'Save knowledge (expected version 0)',exact:true}).click();
  await page.getByText('Revision history (latest 20)',{exact:true}).waitFor();
  await page.getByText(/Saved version 1/).waitFor();
  checks.push('admin saved knowledge and rendered revision history');
  console.log(JSON.stringify({site,checks,status:'pass'}));
} catch (error) {
  const message = String(error instanceof Error ? error.message : error).replaceAll(password || '__no_password__', '[redacted]').replaceAll(email || '__no_email__', '[fixture-email]').replace(/[\r\n]+/g, ' ').slice(0, 700);
  console.error('::error title=Nari deployed UI acceptance::' + message);
  throw new Error(message);
} finally {
  if (browser) await browser.close();
  await fixture('cleanup');
  console.log('Temporary UI fixture cleanup completed.');
}
