const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLIC_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_JWT || process.env.SUPABASE_SECRET_KEY;

function send(res, status, body){
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseBody(req){
  if (!req.body) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}

function cleanString(value){
  return String(value == null ? '' : value).trim();
}

function serviceHeaders(extra){
  return Object.assign({
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    apikey: SUPABASE_SERVICE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

async function supabaseFetch(path, options){
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
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token){
    const error = new Error('Missing session.');
    error.status = 401;
    throw error;
  }
  const authUser = await supabaseFetch('/auth/v1/user', {
    headers: { Authorization:`Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
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

function normalizeUserPayload(body, partial){
  const role = cleanString(body.role || 'client');
  if (!['admin','staff','client'].includes(role)) throw Object.assign(new Error('Invalid role.'), { status:400 });
  const name = cleanString(body.name);
  const email = cleanString(body.email).toLowerCase();
  const phone = cleanString(body.phone);
  const customerId = cleanString(body.customerId || body.customer_id) || null;
  const password = cleanString(body.password);
  const active = body.active !== false && body.active !== 'false';
  if (!partial && !name) throw Object.assign(new Error('Name is required.'), { status:400 });
  if (!partial && !email) throw Object.assign(new Error('Email is required.'), { status:400 });
  if (!partial && !password) throw Object.assign(new Error('Initial password is required.'), { status:400 });
  if (role === 'client' && !customerId) throw Object.assign(new Error('Client users must be linked to a customer.'), { status:400 });
  return { name, email, phone, role, customerId, password, active };
}

async function upsertProfile(id, data){
  const avatar = cleanString(data.name).split(/\s+/).map(part => part[0]).filter(Boolean).slice(0,2).join('').toUpperCase() || 'US';
  const profile = {
    id,
    email:data.email,
    name:data.name,
    role:data.role,
    avatar,
    active:data.active,
    customer_id:data.role === 'client' ? data.customerId : null,
    phone:data.phone
  };
  await supabaseFetch('/rest/v1/profiles?on_conflict=id', {
    method:'POST',
    headers:serviceHeaders({ Prefer:'resolution=merge-duplicates,return=minimal' }),
    body:JSON.stringify(profile)
  });
  return Object.assign({ id, customerId:profile.customer_id }, profile);
}

async function handler(req, res){
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) return send(res, 500, { error:'Supabase admin environment is not configured.' });
  try {
    const admin = await requireAdmin(req);
    const body = parseBody(req);
    if (req.method === 'POST'){
      const data = normalizeUserPayload(body, false);
      const existing = await supabaseFetch('/auth/v1/admin/users?page=1&per_page=1000', { headers:serviceHeaders() });
      if ((existing.users || []).some(user => (user.email || '').toLowerCase() === data.email)){
        return send(res, 409, { error:'A user with this email already exists.' });
      }
      const user = await supabaseFetch('/auth/v1/admin/users', {
        method:'POST',
        headers:serviceHeaders(),
        body:JSON.stringify({
          email:data.email,
          password:data.password,
          email_confirm:true,
          user_metadata:{ name:data.name, role:data.role, customer_id:data.customerId || '', phone:data.phone || '' }
        })
      });
      const profile = await upsertProfile(user.id, data);
      return send(res, 201, { user:profile });
    }
    if (req.method === 'PATCH'){
      const id = cleanString(body.id);
      if (!id) return send(res, 400, { error:'User id is required.' });
      const data = normalizeUserPayload(body, true);
      const authPatch = {
        email_confirm:true,
        user_metadata:{ name:data.name, role:data.role, customer_id:data.customerId || '', phone:data.phone || '' }
      };
      if (data.email) authPatch.email = data.email;
      if (data.password) authPatch.password = data.password;
      await supabaseFetch(`/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method:'PUT',
        headers:serviceHeaders(),
        body:JSON.stringify(authPatch)
      });
      const profile = await upsertProfile(id, data);
      return send(res, 200, { user:profile });
    }
    if (req.method === 'DELETE'){
      const id = cleanString(body.id || (req.query && req.query.id));
      if (!id) return send(res, 400, { error:'User id is required.' });
      if (id === admin.id) return send(res, 400, { error:'You cannot remove your own account.' });
      await supabaseFetch(`/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method:'DELETE',
        headers:serviceHeaders()
      });
      return send(res, 200, { ok:true });
    }
    return send(res, 405, { error:'Method not allowed.' });
  } catch (error){
    return send(res, error.status || 500, { error:error.message || 'User management failed.' });
  }
}

module.exports = handler;
