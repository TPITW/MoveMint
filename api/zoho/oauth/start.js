const { parseBody, requireAdmin, send } = require('../../../lib/api-utils');
const { buildOAuthUrl } = require('../../../lib/zoho-books');

async function handler(req, res){
  if (!['GET','POST'].includes(req.method)) return send(res, 405, { error:'Method not allowed.' });
  try {
    const admin = await requireAdmin(req);
    const body = parseBody(req);
    const url = buildOAuthUrl(admin, body.returnTo || req.query?.returnTo);
    return send(res, 200, { url });
  } catch (error){
    return send(res, error.status || 500, { error:error.message || 'Could not start Zoho OAuth.' });
  }
}

module.exports = handler;
