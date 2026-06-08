const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLIC_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_JWT || process.env.SUPABASE_SECRET_KEY;

function send(res, status, body){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function sendHtml(res, status, html){
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(html);
}

function parseBody(req){
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}

function cleanString(value){
  return String(value == null ? '' : value).trim();
}

function requireSupabaseConfig(){
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY){
    const error = new Error('Supabase admin environment is not configured.');
    error.status = 500;
    throw error;
  }
}

function serviceHeaders(extra){
  return Object.assign({
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    apikey: SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

async function supabaseFetch(path, options){
  requireSupabaseConfig();
  const response = await fetch(`${SUPABASE_URL}${path}`, options);
  const text = await response.text();
  let data = null;
  if (text){
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok){
    const message = typeof data === 'string' ? data : (data && (data.message || data.msg || data.error)) || 'Supabase request failed.';
    const error = new Error(message);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

async function requireAdmin(req){
  requireSupabaseConfig();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token){
    const error = new Error('Missing session.');
    error.status = 401;
    throw error;
  }
  const authUser = await supabaseFetch('/auth/v1/user', {
    headers: { Authorization:`Bearer ${token}`, apikey:SUPABASE_ANON_KEY }
  });
  const profile = await supabaseFetch(`/rest/v1/profiles?select=id,email,role,active&id=eq.${encodeURIComponent(authUser.id)}`, {
    headers: serviceHeaders()
  });
  const p = Array.isArray(profile) ? profile[0] : null;
  if (!p || p.active !== true || p.role !== 'admin'){
    const error = new Error('Admin access required.');
    error.status = 403;
    throw error;
  }
  return p;
}

function publicBaseUrl(){
  return cleanString(process.env.PUBLIC_BASE_URL || process.env.MOVEMINT_PUBLIC_URL || 'https://movemint-lb.vercel.app').replace(/\/$/, '');
}

module.exports = {
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_KEY,
  SUPABASE_URL,
  cleanString,
  parseBody,
  publicBaseUrl,
  requireAdmin,
  requireSupabaseConfig,
  send,
  sendHtml,
  serviceHeaders,
  supabaseFetch
};
