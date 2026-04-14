// /api/ingest-batch-audit.js
// Callback from VPS agent after batch Surge audit completes.
// Receives per-page results + cluster synthesis, updates DB, notifies team.
//
// POST body: {
//   batch_id,
//   pages: [{ content_page_id, surge_raw_data, variance_score, variance_label }],
//   synthesis_raw,
//   surge_batch_url
// }

var email = require('./_lib/email-template');
var sb = require('./_lib/supabase');

module.exports = async function(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: agent key
  var AGENT_KEY = process.env.AGENT_API_KEY;
  var authHeader = req.headers.authorization || '';
  if (!AGENT_KEY || authHeader !== 'Bearer ' + AGENT_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  var RESEND_KEY = process.env.RESEND_API_KEY;
  var body = req.body;
  if (!body || !body.batch_id) return res.status(400).json({ error: 'batch_id required' });

  try {
    // 1. Fetch the batch record
    var batch = await sb.one('content_audit_batches?id=eq.' + body.batch_id + '&limit=1');
    if (!batch) return res.status(404).json({ error: 'Batch not found' });

    var pages = body.pages || [];
    var pagesProcessed = 0;
    var pagesErrors = 0;

    // 2. Update each content page with Surge results
    for (var i = 0; i < pages.length; i++) {
      var pg = pages[i];
      if (!pg.content_page_id) continue;

      var updateData = {
        surge_status: 'complete',
        surge_raw_data: pg.surge_raw_data || null,
        variance_score: pg.variance_score || null,
        variance_label: pg.variance_label || null,
        status: 'audit_loaded',
        updated_at: new Date().toISOString()
      };

      // Extract RTPBA and schema from raw data if available
      if (pg.surge_raw_data) {
        var extracted = extractFromSurge(pg.surge_raw_data);
        if (extracted.rtpba) updateData.rtpba = extracted.rtpba;
        if (extracted.schema) updateData.schema_recommendations = extracted.schema;
      }

      try {
        await sb.mutate('content_pages?id=eq.' + pg.content_page_id, 'PATCH', updateData, 'return=minimal');
        pagesProcessed++;
      } catch (e) {
        console.error('Failed to update content_page ' + pg.content_page_id + ':', e.message);
        pagesErrors++;
      }
    }

    // 3. Update batch record
    var batchUpdate = {
      status: 'complete',
      pages_processed: pagesProcessed,
      synthesis_raw: body.synthesis_raw || null,
      surge_batch_url: body.surge_batch_url || null,
      error_message: pagesErrors > 0 ? pagesErrors + ' page(s) failed to update' : null,
      updated_at: new Date().toISOString()
    };
    await sb.mutate('content_audit_batches?id=eq.' + body.batch_id, 'PATCH', batchUpdate, 'return=minimal');

    // 4. Send team notification
    if (RESEND_KEY) {
      try {
        var contact = await sb.one('contacts?slug=eq.' + batch.client_slug + '&select=first_name,last_name,practice_name&limit=1');
        var clientName = contact ? ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim() : batch.client_slug;
        var practice = contact ? contact.practice_name : '';

        var synthStatus = body.synthesis_raw ? 'Cluster synthesis captured (' + body.synthesis_raw.length + ' chars)' : 'No synthesis generated';
        var content = email.sectionHeading(clientName) +
          (practice ? email.p(email.esc(practice)) : '') +
          email.p('Batch content audit complete: <strong>' + pagesProcessed + '</strong> of <strong>' + pages.length + '</strong> pages processed.' +
            (pagesErrors > 0 ? ' <span style="color:#EF4444">' + pagesErrors + ' error(s)</span>.' : '')) +
          email.p(email.esc(synthStatus)) +
          email.cta('https://clients.moonraker.ai/admin/clients?slug=' + batch.client_slug, 'View Content Tab');

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: email.FROM.notifications,
            to: ['support@moonraker.ai', 'chris@moonraker.ai'],
            subject: 'Batch Audit Complete: ' + clientName,
            html: email.wrap({ headerLabel: 'Batch Audit Complete', content: content })
          })
        });
      } catch (emailErr) {
        console.error('Notification email failed:', emailErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      batch_id: body.batch_id,
      pages_processed: pagesProcessed,
      pages_errors: pagesErrors,
      has_synthesis: !!(body.synthesis_raw)
    });

  } catch (err) {
    console.error('ingest-batch-audit error:', err);
    return res.status(500).json({ error: err.message });
  }
};

function extractFromSurge(rawData) {
  var result = { rtpba: null, schema: null };
  if (!rawData) return result;

  var text = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);

  // Extract RTPBA section
  var rtpbaMarkers = ['Ready-to-Publish', 'RTPBA', 'Ready to Publish'];
  for (var i = 0; i < rtpbaMarkers.length; i++) {
    var idx = text.indexOf(rtpbaMarkers[i]);
    if (idx > -1) {
      result.rtpba = text.substring(idx, Math.min(idx + 8000, text.length));
      break;
    }
  }

  // Extract schema recommendations
  var schemaMarkers = ['Schema Recommendation', 'schema_recommendations', 'Structured Data'];
  for (var j = 0; j < schemaMarkers.length; j++) {
    var sIdx = text.indexOf(schemaMarkers[j]);
    if (sIdx > -1) {
      var schemaText = text.substring(sIdx, Math.min(sIdx + 3000, text.length));
      try {
        // Try to parse as JSON if possible
        var jsonStart = schemaText.indexOf('{');
        var jsonEnd = schemaText.lastIndexOf('}');
        if (jsonStart > -1 && jsonEnd > jsonStart) {
          result.schema = JSON.parse(schemaText.substring(jsonStart, jsonEnd + 1));
        }
      } catch(e) {
        result.schema = { raw: schemaText.substring(0, 2000) };
      }
      break;
    }
  }

  return result;
}
