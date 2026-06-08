const { requireAdmin, send } = require('../../lib/api-utils');
const { syncZohoBooks } = require('../../lib/zoho-books');

async function handler(req, res){
  if (req.method !== 'POST') return send(res, 405, { error:'Method not allowed.' });
  try {
    await requireAdmin(req);
    const counts = await syncZohoBooks();
    return send(res, 200, { ok:true, counts });
  } catch (error){
    return send(res, error.status || 500, { error:error.message || 'Zoho sync failed.' });
  }
}

module.exports = handler;
