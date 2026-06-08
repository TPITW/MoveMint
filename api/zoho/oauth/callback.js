const { publicBaseUrl, sendHtml } = require('../../../lib/api-utils');
const { connectWithCode } = require('../../../lib/zoho-books');

function escapeHtml(value){
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page(title, body){
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)} | MoveMint</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#0f172a;font-family:Montserrat,Inter,Arial,sans-serif}
    main{width:min(520px,calc(100% - 32px));background:#fff;border:1px solid #dbe3ef;border-radius:14px;padding:28px;box-shadow:0 18px 45px rgba(15,23,42,.10)}
    h1{font-size:22px;margin:0 0 8px;font-weight:600}
    p{font-size:14px;line-height:1.6;color:#526070;margin:0 0 18px}
    a{display:inline-flex;align-items:center;justify-content:center;height:40px;padding:0 16px;border-radius:10px;background:#19a47f;color:#fff;text-decoration:none;font-size:13px;font-weight:600}
  </style>
</head>
<body><main>${body}</main></body>
</html>`;
}

async function handler(req, res){
  if (req.method !== 'GET') return sendHtml(res, 405, page('Method not allowed', '<h1>Method not allowed</h1><p>This endpoint only accepts Zoho OAuth callbacks.</p>'));
  try {
    const code = req.query?.code;
    const state = req.query?.state;
    if (!code || !state) return sendHtml(res, 400, page('Zoho connection failed', '<h1>Zoho connection failed</h1><p>Zoho did not return the expected authorization data.</p>'));
    const result = await connectWithCode(code, state);
    const org = result.row?.organization_name || result.row?.organization_id || 'your Zoho Books organization';
    const back = `${publicBaseUrl()}/movemint-portal.html`;
    return sendHtml(res, 200, page('Zoho connected', `
      <h1>Zoho Books connected</h1>
      <p>MoveMint is now connected to ${escapeHtml(org)}. Return to Settings and run the first sync.</p>
      <a href="${escapeHtml(back)}">Return to MoveMint</a>
    `));
  } catch (error){
    return sendHtml(res, error.status || 500, page('Zoho connection failed', `
      <h1>Zoho connection failed</h1>
      <p>${escapeHtml(error.message || 'Could not complete the Zoho Books connection.')}</p>
      <a href="${escapeHtml(publicBaseUrl() + '/movemint-portal.html')}">Return to MoveMint</a>
    `));
  }
}

module.exports = handler;
