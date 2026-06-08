const crypto = require('node:crypto');
const {
  SUPABASE_SERVICE_KEY,
  cleanString,
  publicBaseUrl,
  serviceHeaders,
  supabaseFetch
} = require('./api-utils');

const ZOHO_SCOPES = [
  'ZohoBooks.contacts.READ',
  'ZohoBooks.invoices.READ',
  'ZohoBooks.estimates.READ',
  'ZohoBooks.customerpayments.READ',
  'ZohoBooks.expenses.READ',
  'ZohoBooks.settings.READ'
];

const DC_DOMAINS = {
  com: { accounts:'https://accounts.zoho.com', api:'https://www.zohoapis.com/books/v3' },
  eu: { accounts:'https://accounts.zoho.eu', api:'https://www.zohoapis.eu/books/v3' },
  in: { accounts:'https://accounts.zoho.in', api:'https://www.zohoapis.in/books/v3' },
  au: { accounts:'https://accounts.zoho.com.au', api:'https://www.zohoapis.com.au/books/v3' },
  jp: { accounts:'https://accounts.zoho.jp', api:'https://www.zohoapis.jp/books/v3' },
  ca: { accounts:'https://accounts.zohocloud.ca', api:'https://www.zohoapis.ca/books/v3' },
  sa: { accounts:'https://accounts.zoho.sa', api:'https://www.zohoapis.sa/books/v3' }
};

function normalizeDc(value){
  const dc = cleanString(value || 'com').toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^accounts\./, '')
    .replace(/^zohoapis\./, '')
    .replace(/^zoho\./, '')
    .replace(/\/.*$/, '');
  if (dc === 'zoho.com' || dc === 'com' || dc === '') return 'com';
  if (dc === 'com.au') return 'au';
  return DC_DOMAINS[dc] ? dc : 'com';
}

function getZohoConfig(){
  const dataCenter = normalizeDc(process.env.ZOHO_DATA_CENTER || process.env.ZOHO_DC || 'com');
  const domains = DC_DOMAINS[dataCenter] || DC_DOMAINS.com;
  const redirectUri = cleanString(process.env.ZOHO_REDIRECT_URI) || `${publicBaseUrl()}/api/zoho/oauth/callback`;
  const config = {
    apiBase: cleanString(process.env.ZOHO_API_BASE) || domains.api,
    accountsUrl: cleanString(process.env.ZOHO_ACCOUNTS_URL) || domains.accounts,
    clientId: cleanString(process.env.ZOHO_CLIENT_ID),
    clientSecret: cleanString(process.env.ZOHO_CLIENT_SECRET),
    dataCenter,
    organizationId: cleanString(process.env.ZOHO_ORG_ID || process.env.ZOHO_ORGANIZATION_ID),
    redirectUri
  };
  config.configured = !!(config.clientId && config.clientSecret && config.organizationId);
  return config;
}

function requireZohoConfig(){
  const config = getZohoConfig();
  if (!config.configured){
    const error = new Error('Zoho Books environment is not configured.');
    error.status = 500;
    throw error;
  }
  return config;
}

function b64url(buffer){
  return Buffer.from(buffer).toString('base64url');
}

function stateSecret(){
  return process.env.ZOHO_STATE_SECRET || process.env.ZOHO_TOKEN_ENCRYPTION_KEY || SUPABASE_SERVICE_KEY || 'movemint-zoho-state';
}

function createOAuthState(admin, returnTo){
  const payload = {
    nonce: b64url(crypto.randomBytes(12)),
    returnTo: cleanString(returnTo) || '/movemint-portal.html',
    ts: Date.now(),
    uid: admin.id
  };
  const encoded = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', stateSecret()).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyOAuthState(state){
  const [encoded, sig] = cleanString(state).split('.');
  if (!encoded || !sig){
    const error = new Error('Invalid OAuth state.');
    error.status = 400;
    throw error;
  }
  const expected = crypto.createHmac('sha256', stateSecret()).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)){
    const error = new Error('Invalid OAuth state.');
    error.status = 400;
    throw error;
  }
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!payload.ts || Date.now() - payload.ts > 20 * 60 * 1000){
    const error = new Error('OAuth state expired. Start the connection again.');
    error.status = 400;
    throw error;
  }
  return payload;
}

function buildOAuthUrl(admin, returnTo){
  const config = requireZohoConfig();
  const url = new URL('/oauth/v2/auth', config.accountsUrl);
  url.searchParams.set('scope', ZOHO_SCOPES.join(','));
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', createOAuthState(admin, returnTo));
  return url.toString();
}

async function tokenRequest(params){
  const config = requireZohoConfig();
  const response = await fetch(`${config.accountsUrl}/oauth/v2/token`, {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body:new URLSearchParams(Object.assign({
      client_id:config.clientId,
      client_secret:config.clientSecret
    }, params))
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok || data.error){
    const message = data.error_description || data.error || 'Zoho token request failed.';
    const error = new Error(message);
    error.status = response.status || 400;
    error.details = data;
    throw error;
  }
  return data;
}

async function exchangeCode(code){
  const config = requireZohoConfig();
  return tokenRequest({
    code,
    grant_type:'authorization_code',
    redirect_uri:config.redirectUri
  });
}

async function refreshAccessToken(refreshToken){
  return tokenRequest({
    refresh_token:refreshToken,
    grant_type:'refresh_token'
  });
}

function encryptionKey(){
  const raw = cleanString(process.env.ZOHO_TOKEN_ENCRYPTION_KEY);
  if (!raw){
    const error = new Error('ZOHO_TOKEN_ENCRYPTION_KEY is not configured.');
    error.status = 500;
    throw error;
  }
  const key = /^[A-Za-z0-9+/_-]+={0,2}$/.test(raw) && raw.length >= 43
    ? Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    : crypto.createHash('sha256').update(raw).digest();
  if (key.length !== 32){
    const error = new Error('ZOHO_TOKEN_ENCRYPTION_KEY must resolve to 32 bytes.');
    error.status = 500;
    throw error;
  }
  return key;
}

function encryptRefreshToken(refreshToken){
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(refreshToken, 'utf8'), cipher.final()]);
  return {
    refresh_token_encrypted: encrypted.toString('base64'),
    refresh_token_iv: iv.toString('base64'),
    refresh_token_tag: cipher.getAuthTag().toString('base64')
  };
}

function decryptRefreshToken(connection){
  if (process.env.ZOHO_REFRESH_TOKEN) return cleanString(process.env.ZOHO_REFRESH_TOKEN);
  if (!connection || !connection.refresh_token_encrypted || !connection.refresh_token_iv || !connection.refresh_token_tag) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(connection.refresh_token_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(connection.refresh_token_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(connection.refresh_token_encrypted, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

async function getConnection(){
  const rows = await supabaseFetch('/rest/v1/zoho_connections?select=*&id=eq.default&limit=1', {
    headers: serviceHeaders()
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function saveConnection(fields){
  const payload = Object.assign({ id:'default', updated_at:new Date().toISOString() }, fields);
  const rows = await supabaseFetch('/rest/v1/zoho_connections?on_conflict=id', {
    method:'POST',
    headers: serviceHeaders({ Prefer:'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(payload)
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function updateConnection(fields){
  await supabaseFetch('/rest/v1/zoho_connections?id=eq.default', {
    method:'PATCH',
    headers: serviceHeaders({ Prefer:'return=minimal' }),
    body: JSON.stringify(Object.assign({ updated_at:new Date().toISOString() }, fields))
  });
}

async function deleteConnection(){
  await supabaseFetch('/rest/v1/zoho_connections?id=eq.default', {
    method:'DELETE',
    headers: serviceHeaders({ Prefer:'return=minimal' })
  });
}

async function zohoApiFetch(path, accessToken, params){
  const config = requireZohoConfig();
  const url = new URL(path.startsWith('http') ? path : `${config.apiBase}${path}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  if (!/\/organizations(?:\?|$)/.test(url.pathname) && !url.searchParams.has('organization_id')){
    url.searchParams.set('organization_id', config.organizationId);
  }
  const response = await fetch(url, {
    headers:{ Authorization:`Zoho-oauthtoken ${accessToken}` }
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok || (data.code && Number(data.code) !== 0)){
    const error = new Error(data.message || data.error || 'Zoho Books API request failed.');
    error.status = response.status || 502;
    error.details = data;
    throw error;
  }
  return data;
}

async function listPaginated(resource, key, accessToken, params){
  const items = [];
  let page = 1;
  for (;;){
    const data = await zohoApiFetch(`/${resource}`, accessToken, Object.assign({ page, per_page:200 }, params || {}));
    items.push(...(Array.isArray(data[key]) ? data[key] : []));
    const ctx = data.page_context || {};
    if (!ctx.has_more_page || page >= 50) break;
    page += 1;
  }
  return items;
}

function normalizeName(value){
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function firstEmail(contact){
  const people = Array.isArray(contact.contact_persons) ? contact.contact_persons : [];
  return cleanString(contact.email || contact.primary_email || people.find(p => p.email)?.email).toLowerCase();
}

function contactName(contact){
  return cleanString(contact.company_name || contact.contact_name || contact.customer_name || contact.vendor_name || 'Zoho Contact');
}

function contactCountry(contact){
  return cleanString(contact.billing_address?.country || contact.shipping_address?.country || contact.country);
}

function contactPhone(contact){
  return cleanString(contact.phone || contact.mobile || contact.billing_address?.phone || contact.shipping_address?.phone);
}

function normalizeDate(value){
  const v = cleanString(value);
  if (!v) return null;
  const match = v.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function numberValue(value){
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapInvoiceStatus(invoice){
  const status = cleanString(invoice.status || invoice.status_formatted).toLowerCase();
  const balance = numberValue(invoice.balance);
  const total = numberValue(invoice.total || invoice.amount);
  if (status.includes('overdue')) return 'Overdue';
  if (status.includes('paid') && !status.includes('unpaid')) return 'Paid';
  if (total > 0 && balance <= 0) return 'Paid';
  return 'Pending';
}

function mapEstimateStatus(estimate){
  const status = cleanString(estimate.status || estimate.status_formatted).toLowerCase();
  if (status.includes('accept')) return 'Accepted';
  if (status.includes('declin') || status.includes('reject')) return 'Rejected';
  if (status.includes('expir')) return 'Expired';
  if (status.includes('draft')) return 'Draft';
  return 'Sent';
}

function extractShipmentRef(source){
  const text = JSON.stringify(source || {});
  const match = text.match(/MM-\d{4}-\d{4}/);
  return match ? match[0] : '';
}

function buildPaymentIndex(payments){
  const byInvoice = new Map();
  function push(key, entry){
    const k = cleanString(key);
    if (!k) return;
    if (!byInvoice.has(k)) byInvoice.set(k, []);
    byInvoice.get(k).push(entry);
  }
  payments.forEach(payment => {
    const date = normalizeDate(payment.date || payment.payment_date);
    const method = cleanString(payment.payment_mode || payment.payment_mode_formatted || payment.payment_method) || 'Zoho Books';
    const defaultAmount = numberValue(payment.amount || payment.total);
    const refs = Array.isArray(payment.invoices) ? payment.invoices : [];
    if (refs.length){
      refs.forEach(ref => {
        const entry = { date, amount:numberValue(ref.amount_applied || ref.amount || defaultAmount), method };
        push(ref.invoice_id, entry);
        push(ref.invoice_number, entry);
      });
    } else {
      const entry = { date, amount:defaultAmount, method };
      push(payment.invoice_id, entry);
      push(payment.invoice_number, entry);
    }
  });
  return byInvoice;
}

function mapContacts(contacts, existingCustomers){
  const byZoho = new Map();
  const byEmail = new Map();
  const byName = new Map();
  existingCustomers.forEach(customer => {
    if (customer.zoho) byZoho.set(cleanString(customer.zoho), customer);
    if (customer.email) byEmail.set(cleanString(customer.email).toLowerCase(), customer);
    byName.set(normalizeName(customer.name), customer);
  });
  const rows = [];
  const customerIdByZoho = new Map();
  const customerNameByZoho = new Map();
  contacts.forEach(contact => {
    const zohoId = cleanString(contact.contact_id);
    if (!zohoId) return;
    const email = firstEmail(contact);
    const name = contactName(contact);
    const existing = byZoho.get(zohoId) || (email && byEmail.get(email)) || byName.get(normalizeName(name));
    const id = existing?.id || `zoho-${zohoId}`;
    customerIdByZoho.set(zohoId, id);
    customerNameByZoho.set(zohoId, name);
    rows.push({
      id,
      name,
      type: cleanString(contact.contact_type).toLowerCase() === 'person' ? 'Individual' : 'Company',
      email,
      phone: contactPhone(contact),
      country: contactCountry(contact),
      zoho: zohoId,
      portal: existing?.portal === true,
      active: existing?.active == null ? 0 : existing.active,
      delivered: existing?.delivered == null ? 0 : existing.delivered,
      last: existing?.last || normalizeDate(contact.created_time || contact.last_modified_time)
    });
  });
  return { rows, customerIdByZoho, customerNameByZoho };
}

function mapInvoices(invoices, existingInvoices, customerMaps, payments){
  const existingById = new Map(existingInvoices.map(invoice => [invoice.id, invoice]));
  const paymentIndex = buildPaymentIndex(payments);
  return invoices.map(invoice => {
    const id = cleanString(invoice.invoice_number) || `ZINV-${cleanString(invoice.invoice_id)}`;
    const existing = existingById.get(id);
    const zohoCustomerId = cleanString(invoice.customer_id);
    const history = [
      ...(paymentIndex.get(cleanString(invoice.invoice_id)) || []),
      ...(paymentIndex.get(cleanString(invoice.invoice_number)) || [])
    ].filter(entry => entry.date || entry.amount);
    const status = mapInvoiceStatus(invoice);
    const paidDate = status === 'Paid'
      ? (normalizeDate(invoice.paid_date || invoice.last_payment_date) || history[history.length - 1]?.date || existing?.paid_date || null)
      : null;
    return {
      id,
      customer: customerMaps.customerIdByZoho.get(zohoCustomerId) || existing?.customer || (zohoCustomerId ? `zoho-${zohoCustomerId}` : ''),
      client_name: cleanString(invoice.customer_name) || customerMaps.customerNameByZoho.get(zohoCustomerId) || existing?.client_name || '',
      shipment: extractShipmentRef(invoice) || existing?.shipment || '',
      amount: numberValue(invoice.total || invoice.amount),
      currency: cleanString(invoice.currency_code || invoice.currency_symbol) || existing?.currency || 'USD',
      status,
      issue_date: normalizeDate(invoice.date),
      due_date: normalizeDate(invoice.due_date),
      paid_date: paidDate,
      link: cleanString(invoice.invoice_url || invoice.url || invoice.web_url || existing?.link),
      history
    };
  });
}

function mapEstimates(estimates, existingQuotations, customerMaps){
  const existingById = new Map(existingQuotations.map(quote => [quote.id, quote]));
  return estimates.map(estimate => {
    const id = cleanString(estimate.estimate_number) || `ZEST-${cleanString(estimate.estimate_id)}`;
    const existing = existingById.get(id);
    const zohoCustomerId = cleanString(estimate.customer_id);
    return {
      id,
      customer: customerMaps.customerIdByZoho.get(zohoCustomerId) || existing?.customer || (zohoCustomerId ? `zoho-${zohoCustomerId}` : ''),
      client_name: cleanString(estimate.customer_name) || customerMaps.customerNameByZoho.get(zohoCustomerId) || existing?.client_name || '',
      origin: existing?.origin || '',
      destination: existing?.destination || '',
      mode: existing?.mode || '',
      incoterm: existing?.incoterm || '',
      cbm: existing?.cbm || 0,
      weight: existing?.weight || '',
      freight_cost: existing?.freight_cost || 0,
      selling_price: numberValue(estimate.total || estimate.amount),
      status: mapEstimateStatus(estimate),
      date: normalizeDate(estimate.date),
      valid_until: cleanString(estimate.expiry_date || estimate.valid_until || existing?.valid_until),
      requested: existing?.requested === true,
      shipment: extractShipmentRef(estimate) || existing?.shipment || ''
    };
  });
}

async function readTable(table, select){
  return supabaseFetch(`/rest/v1/${table}?select=${encodeURIComponent(select || '*')}`, {
    headers: serviceHeaders()
  });
}

async function upsertRows(table, rows){
  if (!rows.length) return 0;
  await supabaseFetch(`/rest/v1/${table}?on_conflict=id`, {
    method:'POST',
    headers: serviceHeaders({ Prefer:'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows)
  });
  return rows.length;
}

async function getOrganizationSummary(accessToken){
  try {
    const config = requireZohoConfig();
    const data = await zohoApiFetch('/organizations', accessToken);
    const orgs = Array.isArray(data.organizations) ? data.organizations : [];
    const org = orgs.find(item => cleanString(item.organization_id) === config.organizationId) || orgs[0] || {};
    return {
      organization_name: cleanString(org.name || org.organization_name),
      organization_id: cleanString(org.organization_id) || config.organizationId
    };
  } catch {
    const config = requireZohoConfig();
    return { organization_name:'', organization_id:config.organizationId };
  }
}

async function connectWithCode(code, state){
  const config = requireZohoConfig();
  const statePayload = verifyOAuthState(state);
  const token = await exchangeCode(code);
  let refreshToken = cleanString(token.refresh_token);
  const existing = await getConnection().catch(() => null);
  if (!refreshToken && existing) refreshToken = decryptRefreshToken(existing);
  if (!refreshToken){
    const error = new Error('Zoho did not return a refresh token. Revoke the app in Zoho and connect again.');
    error.status = 400;
    throw error;
  }
  const summary = token.access_token ? await getOrganizationSummary(token.access_token) : { organization_id:config.organizationId, organization_name:'' };
  const row = await saveConnection(Object.assign({
    accounts_url: config.accountsUrl,
    api_base_url: config.apiBase,
    connected_at: existing?.connected_at || new Date().toISOString(),
    connected_by: statePayload.uid,
    data_center: config.dataCenter,
    organization_id: summary.organization_id || config.organizationId,
    organization_name: summary.organization_name || existing?.organization_name || '',
    last_sync_status: existing?.last_sync_status || 'not_synced'
  }, encryptRefreshToken(refreshToken)));
  return { row, state:statePayload };
}

async function syncZohoBooks(){
  const config = requireZohoConfig();
  const connection = await getConnection();
  const refreshToken = decryptRefreshToken(connection);
  if (!refreshToken){
    const error = new Error('Zoho Books is not connected. Connect OAuth first.');
    error.status = 409;
    throw error;
  }
  await updateConnection({ last_sync_status:'running', last_sync_error:null });
  try {
    const token = await refreshAccessToken(refreshToken);
    const accessToken = token.access_token;
    const [contacts, invoices, estimates, payments, existingCustomers, existingInvoices, existingQuotations] = await Promise.all([
      listPaginated('contacts', 'contacts', accessToken),
      listPaginated('invoices', 'invoices', accessToken),
      listPaginated('estimates', 'estimates', accessToken),
      listPaginated('customerpayments', 'customerpayments', accessToken),
      readTable('customers', '*'),
      readTable('invoices', '*'),
      readTable('quotations', '*')
    ]);
    const customerMaps = mapContacts(contacts, existingCustomers);
    const invoiceRows = mapInvoices(invoices, existingInvoices, customerMaps, payments);
    const quotationRows = mapEstimates(estimates, existingQuotations, customerMaps);
    const counts = {
      customers: await upsertRows('customers', customerMaps.rows),
      invoices: await upsertRows('invoices', invoiceRows),
      quotations: await upsertRows('quotations', quotationRows),
      payments: payments.length
    };
    const summary = await getOrganizationSummary(accessToken);
    await saveConnection({
      organization_id: summary.organization_id || config.organizationId,
      organization_name: summary.organization_name || connection?.organization_name || '',
      accounts_url: config.accountsUrl,
      api_base_url: config.apiBase,
      data_center: config.dataCenter,
      last_sync_at: new Date().toISOString(),
      last_sync_status: 'success',
      last_sync_error: null
    });
    return counts;
  } catch (error){
    await updateConnection({
      last_sync_at: new Date().toISOString(),
      last_sync_status: 'failed',
      last_sync_error: error.message || 'Zoho sync failed.'
    }).catch(() => {});
    throw error;
  }
}

function publicConnection(connection){
  const config = getZohoConfig();
  return {
    apiBase: config.apiBase,
    configured: config.configured,
    connected: !!(process.env.ZOHO_REFRESH_TOKEN || connection?.refresh_token_encrypted),
    dataCenter: connection?.data_center || config.dataCenter,
    lastSyncAt: connection?.last_sync_at || null,
    lastSyncError: connection?.last_sync_error || null,
    lastSyncStatus: connection?.last_sync_status || 'not_connected',
    organizationId: connection?.organization_id || config.organizationId || '',
    organizationName: connection?.organization_name || '',
    redirectUri: config.redirectUri
  };
}

module.exports = {
  ZOHO_SCOPES,
  buildOAuthUrl,
  connectWithCode,
  deleteConnection,
  getConnection,
  getZohoConfig,
  publicConnection,
  syncZohoBooks
};
