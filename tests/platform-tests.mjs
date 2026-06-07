import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const htmlPath = new URL('../movemint-portal.html', import.meta.url);
const apiPath = new URL('../api/admin/users.js', import.meta.url);
const envPath = 'C:/Codex/movemint-secrets/deploy.env';

function loadEnv(){
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)){
    const match = line.match(/^\s*([^#=]+)=(.*)$/);
    if (match) env[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return env;
}

async function fetchJson(url, options){
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  if (text){
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok){
    throw new Error(`${options?.method || 'GET'} ${url} ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return data;
}

function assertHtmlLogic(){
  const html = fs.readFileSync(htmlPath, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  scripts.forEach((script, index) => {
    assert.doesNotThrow(() => new Function(script), `inline script ${index + 1} should compile`);
  });
  assert.match(html, /state\.page = 'portal'/, 'client sessions should default to Track');
  assert.match(html, /data-role="client"[\s\S]*data-page="settings"/, 'client settings nav item should exist');
  assert.match(html, /app\[data-user-role="client"\][\s\S]*data-page="portal"/, 'client mobile nav should style Track separately');
  assert.match(html, /function showAuthError/, 'login error should be transient and reusable');
  assert.match(html, /async function adminUserRequest/, 'user management should call the backend API');
  require(fileURLToPath(apiPath));
}

async function assertLiveSupabase(){
  const env = loadEnv();
  const required = ['SUPABASE_URL','SUPABASE_ACCESS_TOKEN','SUPABASE_PROJECT_REF'];
  if (required.some(key => !env[key])){
    console.log('Skipping live Supabase checks because deployment secrets are not available.');
    return;
  }
  const sbUrl = env.SUPABASE_URL.replace(/\/$/, '');
  const keys = await fetchJson(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/api-keys`, {
    headers:{ Authorization:`Bearer ${env.SUPABASE_ACCESS_TOKEN}` }
  });
  const service = keys.find(key => key.name === 'service_role' && key.type === 'legacy')?.api_key;
  const anon = keys.find(key => key.name === 'anon' && key.type === 'legacy')?.api_key;
  assert.ok(service, 'legacy service role key should be available for admin checks');
  assert.ok(anon, 'legacy anon key should be available for auth checks');

  const adminHeaders = { Authorization:`Bearer ${service}`, apikey:service, 'Content-Type':'application/json' };
  const desired = [
    { email:'patrickjfarah@gmail.com', password:'M0v3M!nt', role:'admin', customer_id:null },
    { email:'admin@movemintlb.com', password:'M0v3M!nt', role:'admin', customer_id:null },
    { email:'support@theitwork.com', password:'movemint', role:'client', customer_id:'cust-the-it-work' }
  ];
  const users = await fetchJson(`${sbUrl}/auth/v1/admin/users?page=1&per_page=1000`, { headers:adminHeaders });
  const emails = (users.users || []).map(user => user.email).sort();
  assert.deepEqual(emails, desired.map(user => user.email).sort(), 'Supabase Auth should contain exactly the requested accounts');

  for (const account of desired){
    const grant = await fetchJson(`${sbUrl}/auth/v1/token?grant_type=password`, {
      method:'POST',
      headers:{ apikey:anon, 'Content-Type':'application/json' },
      body:JSON.stringify({ email:account.email, password:account.password })
    });
    assert.ok(grant.access_token, `${account.email} should authenticate`);
    const profile = await fetchJson(`${sbUrl}/rest/v1/profiles?select=email,role,active,customer_id&email=eq.${encodeURIComponent(account.email)}`, {
      headers:{ Authorization:`Bearer ${grant.access_token}`, apikey:anon }
    });
    assert.equal(profile[0].role, account.role, `${account.email} role should match`);
    assert.equal(profile[0].active, true, `${account.email} should be active`);
    assert.equal(profile[0].customer_id ?? null, account.customer_id, `${account.email} customer scope should match`);
  }

  const wrongPassword = await fetch(`${sbUrl}/auth/v1/token?grant_type=password`, {
    method:'POST',
    headers:{ apikey:anon, 'Content-Type':'application/json' },
    body:JSON.stringify({ email:'admin@movemintlb.com', password:'wrong-password' })
  });
  assert.equal(wrongPassword.ok, false, 'wrong password should fail authentication');

  const adminGrant = await fetchJson(`${sbUrl}/auth/v1/token?grant_type=password`, {
    method:'POST',
    headers:{ apikey:anon, 'Content-Type':'application/json' },
    body:JSON.stringify({ email:'patrickjfarah@gmail.com', password:'M0v3M!nt' })
  });
  const profiles = await fetchJson(`${sbUrl}/rest/v1/profiles?select=email,role,active`, {
    headers:{ Authorization:`Bearer ${adminGrant.access_token}`, apikey:anon }
  });
  assert.equal(profiles.length, 3, 'admin should see three profile rows');

  const clientGrant = await fetchJson(`${sbUrl}/auth/v1/token?grant_type=password`, {
    method:'POST',
    headers:{ apikey:anon, 'Content-Type':'application/json' },
    body:JSON.stringify({ email:'support@theitwork.com', password:'movemint' })
  });
  const clientCustomers = await fetchJson(`${sbUrl}/rest/v1/customers?select=id,name`, {
    headers:{ Authorization:`Bearer ${clientGrant.access_token}`, apikey:anon }
  });
  assert.deepEqual(clientCustomers.map(customer => customer.id), ['cust-the-it-work'], 'client should only see The IT WORK customer row');
}

assertHtmlLogic();
await assertLiveSupabase();
console.log('MoveMint platform tests passed.');
