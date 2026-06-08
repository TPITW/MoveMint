const { requireAdmin, send } = require('../../lib/api-utils');
const { getConnection, publicConnection } = require('../../lib/zoho-books');

async function handler(req, res){
  if (req.method !== 'GET') return send(res, 405, { error:'Method not allowed.' });
  try {
    await requireAdmin(req);
    const connection = await getConnection().catch(error => {
      if (error.status === 404) return null;
      throw error;
    });
    return send(res, 200, publicConnection(connection));
  } catch (error){
    return send(res, error.status || 500, { error:error.message || 'Could not read Zoho status.' });
  }
}

module.exports = handler;
