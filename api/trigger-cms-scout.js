/**
 * /api/trigger-cms-scout.js
 * 
 * Triggers a CMS scout on the Moonraker Agent Service.
 * Dispatches to the correct agent endpoint based on website_platform.
 * 
 * POST body: { contact_id }
 * 
 * Supports: wordpress, squarespace, wix
 */

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;
  var CLIENT_HQ_URL = process.env.CLIENT_HQ_URL || 'https://clients.moonraker.ai';

  if (!AGENT_URL || !AGENT_KEY) return res.status(500).json({ error: 'Agent service not configured' });

  var body = req.body;
  if (!body || !body.contact_id) {
    return res.status(400).json({ error: 'contact_id required' });
  }

  try {
    // Fetch contact
    var contact = await sb.one('contacts?id=eq.' + body.contact_id + '&select=id,slug,website_url,website_platform,cms_login_url,cms_username,cms_password,cms_app_password,practice_name');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!contact.website_url) return res.status(400).json({ error: 'Website URL is required' });

    var platform = (contact.website_platform || '').toLowerCase();
    var agentEndpoint = '';
    var payload = {};

    // ── Build platform-specific payload ──────────────────────────
    if (platform === 'wordpress') {
      agentEndpoint = '/tasks/wp-scout';
      var adminUrl = contact.cms_login_url || (contact.website_url.replace(/\/$/, '') + '/wp-admin');
      payload = {
        wp_admin_url: adminUrl,
        wp_username: contact.cms_username || '',
        wp_password: contact.cms_app_password || contact.cms_password || '',
        client_slug: contact.slug,
        callback_url: CLIENT_HQ_URL + '/api/ingest-cms-scout'
      };
      // WP scout can run public-only if no credentials, but REST API needs app password
      if (!payload.wp_username || !payload.wp_password) {
        // Still allow it - the scout will try public endpoints
        payload.wp_username = payload.wp_username || 'agent';
        payload.wp_password = payload.wp_password || 'none';
      }

    } else if (platform === 'squarespace') {
      agentEndpoint = '/tasks/sq-scout';
      payload = {
        website_url: contact.website_url,
        client_slug: contact.slug,
        callback_url: CLIENT_HQ_URL + '/api/ingest-cms-scout'
      };
      // Add SQ credentials if available
      if (contact.cms_username && contact.cms_password) {
        payload.sq_email = contact.cms_username;
        payload.sq_password = contact.cms_password;
      }

    } else if (platform === 'wix') {
      agentEndpoint = '/tasks/wix-scout';
      payload = {
        website_url: contact.website_url,
        client_slug: contact.slug,
        callback_url: CLIENT_HQ_URL + '/api/ingest-cms-scout'
      };

    } else {
      return res.status(400).json({
        error: 'Unsupported platform: ' + (platform || 'none') + '. Set website_platform to wordpress, squarespace, or wix.'
      });
    }

    // ── Trigger agent ────────────────────────────────────────────
    var agentResp = await fetch(AGENT_URL + agentEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AGENT_KEY
      },
      body: JSON.stringify(payload)
    });

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch(e) {}
      return res.status(502).json({ error: 'Agent returned ' + agentResp.status, detail: errText.substring(0, 300) });
    }

    var agentResult = await agentResp.json();

    // ── Create scout record ──────────────────────────────────────
    await sb.mutate('cms_scouts', 'POST', {
      contact_id: contact.id,
      client_slug: contact.slug,
      platform: platform,
      agent_task_id: agentResult.task_id,
      status: 'running'
    });

    return res.json({
      success: true,
      task_id: agentResult.task_id,
      platform: platform,
      message: platform.charAt(0).toUpperCase() + platform.slice(1) + ' scout started'
    });

  } catch (err) {
    console.error('trigger-cms-scout error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
};
