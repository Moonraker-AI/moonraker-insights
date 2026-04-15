// /api/trigger-design-capture.js
// Triggers the VPS agent to capture design assets for a client.
// Creates a design_specs record if one doesn't exist, then POSTs to agent.
//
// POST body: { contact_id, service_page_url?, about_page_url? }

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;
  if (!AGENT_URL || !AGENT_KEY) return res.status(500).json({ error: 'Agent service not configured' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var body = req.body || {};
  var contactId = body.contact_id;
  if (!contactId) return res.status(400).json({ error: 'contact_id required' });

  try {
    // 1. Fetch contact
    var contact = await sb.one('contacts?id=eq.' + contactId + '&select=id,slug,website_url,practice_name&limit=1');
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    if (!contact.website_url) return res.status(400).json({ error: 'Website URL not set on contact record' });

    // 2. Get or create design spec
    var specs = await sb.query('design_specs?contact_id=eq.' + contactId + '&limit=1');
    var spec = specs && specs[0];

    if (!spec) {
      var created = await sb.mutate('design_specs', 'POST', {
        contact_id: contactId,
        capture_status: 'capturing'
      }, 'return=representation');
      spec = Array.isArray(created) ? created[0] : created;
    } else {
      await sb.mutate('design_specs?id=eq.' + spec.id, 'PATCH', {
        capture_status: 'capturing',
        capture_error: null,
        updated_at: new Date().toISOString()
      }, 'return=minimal');
    }

    if (!spec || !spec.id) return res.status(500).json({ error: 'Failed to create/update design spec' });

    // 3. Trigger agent
    var agentResp = await fetch(AGENT_URL + '/tasks/capture-design-assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + AGENT_KEY },
      body: JSON.stringify({
        design_spec_id: spec.id,
        client_slug: contact.slug,
        website_url: contact.website_url,
        service_page_url: body.service_page_url || null,
        about_page_url: body.about_page_url || null,
        callback_url: 'https://clients.moonraker.ai/api/ingest-design-assets'
      })
    });

    if (!agentResp.ok) {
      var errText = '';
      try { errText = await agentResp.text(); } catch(e) {}
      await sb.mutate('design_specs?id=eq.' + spec.id, 'PATCH', {
        capture_status: 'error',
        capture_error: 'Agent returned ' + agentResp.status
      }, 'return=minimal');
      return res.status(502).json({ error: 'Agent service returned ' + agentResp.status, detail: errText.substring(0, 300) });
    }

    var agentResult = await agentResp.json();

    // 4. Store task ID
    await sb.mutate('design_specs?id=eq.' + spec.id, 'PATCH', {
      agent_task_id: agentResult.task_id
    }, 'return=minimal');

    return res.status(200).json({
      success: true,
      task_id: agentResult.task_id,
      design_spec_id: spec.id,
      message: 'Design asset capture started for ' + contact.website_url
    });

  } catch (err) {
    console.error('trigger-design-capture error:', err);
    return res.status(500).json({ error: err.message });
  }
};
