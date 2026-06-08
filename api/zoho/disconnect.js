const { requireAdmin, send } = require('../../lib/api-utils');
const { deleteConnection } = require('../../lib/zoho-books');

async function handler(req, res){
  if (req.method !== 'POST') return send(res, 405, { error:'Method not allowed.' });
  try {
    await requireAdmin(req);
    await deleteConnection();
    return send(res, 200, { ok:true });
  } catch (error){
    return send(res, error.status || 500, { error:error.message || 'Could not disconnect Zoho Books.' });
  }
}

module.exports = handler;
