// api/_lib/entity-audit-trigger.js
// Creates an entity_audits row and fires the Surge agent for it.
//
// Extracted from api/submit-entity-audit.js (was ~100 lines of inline logic
// there). Called from two places:
//   1. /api/submit-entity-audit — entity-audit landing form intake.
//   2. /api/stripe-webhook strategy_call branch — auto-audit on strategy-call
//      payment, so Scott has visibility data before the call.
//
// Usage:
//   var entityAuditTrigger = require('./_lib/entity-audit-trigger');
//   var result = await entityAuditTrigger.createAndTriggerAudit({
//     contact: { id, slug, first_name, last_name, practice_name },
//     website_url,
//     city, state,
//     gbp_link,
//     audit_tier: 'free'   // default 'free'
//   });
//   // result: { audit_id, agent_triggered: bool, agent_error?: string }
//
// Design rules:
//  1. NEVER throws. An agent failure lands in entity_audits.status='agent_error'
//     with last_agent_error populated; cron/process-audit-queue.js Step 0.5
//     picks those up on a 5-min backoff and auto-retries. That's why callers
//     don't need to retry inline.
//  2. An agent_error flip is NOT fatal to the return. The audit row exists,
//     the contact exists, the cron will retry — we still return the audit_id
//     so callers can surface it.
//  3. Side effect: on agent failure, fires a non-blocking FYI email to
//     notifications@clients.moonraker.ai. Preserves existing behavior from
//     submit-entity-audit.
//  4. Geo target precedence matches legacy behavior: "city, state" if both
//     present, else whichever is non-empty, else null.

var sb = require('./supabase');
var fetchT = require('./fetch-with-timeout');

async function createAndTriggerAudit(opts) {
  opts = opts || {};
  var contact = opts.contact || {};
  var websiteUrl = (opts.website_url || '').trim();
  var city = (opts.city || '').trim();
  var state = (opts.state || '').trim();
  var gbpLink = (opts.gbp_link || '').trim();
  var auditTier = opts.audit_tier === 'premium' ? 'premium' : 'free';

  // Build derived fields. Matches legacy submit-entity-audit exactly.
  var brandQuery = (contact.practice_name && contact.practice_name.trim()) ||
                   ((contact.first_name || '') + ' ' + (contact.last_name || '')).trim();
  var geoTarget = (city && state) ? (city + ', ' + state) : (city || state || '');

  var auditId = null;
  var agentTriggered = false;
  var agentError = null;

  // ── 1. Insert entity_audits row ──
  // If this throws, the caller sees a real error — we cannot mask a DB
  // failure because without the audit row there's nothing for the cron
  // to retry against. Caller wraps in try/catch.
  var auditRows = await sb.mutate('entity_audits', 'POST', {
    contact_id: contact.id,
    client_slug: contact.slug,
    audit_tier: auditTier,
    brand_query: brandQuery,
    homepage_url: websiteUrl,
    status: 'pending',
    geo_target: geoTarget || null,
    gbp_share_link: gbpLink || null
  });
  var audit = Array.isArray(auditRows) ? auditRows[0] : auditRows;
  if (!audit || !audit.id) {
    // Defensive — PostgREST should always return the inserted row with
    // default Prefer=return=representation, but guard against a misconfig.
    throw new Error('entity_audits insert returned no row');
  }
  auditId = audit.id;

  // ── 2. Trigger the agent service ──
  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;

  if (AGENT_URL && AGENT_KEY) {
    try {
      var agentResp = await fetchT(AGENT_URL + '/tasks/surge-audit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + AGENT_KEY
        },
        body: JSON.stringify({
          audit_id: auditId,
          practice_name: brandQuery,
          website_url: websiteUrl,
          city: city || '',
          state: state || '',
          geo_target: geoTarget,
          gbp_link: gbpLink,
          client_slug: contact.slug
        })
      }, 30000);

      if (agentResp.ok) {
        var agentResult = await agentResp.json();
        await sb.mutate('entity_audits?id=eq.' + auditId, 'PATCH', {
          status: 'agent_running',
          agent_task_id: agentResult.task_id
        }, 'return=minimal');
        agentTriggered = true;
      } else {
        agentError = 'Agent returned ' + agentResp.status;
      }
    } catch (e) {
      agentError = e && e.message ? e.message : 'Agent request threw';
    }
  } else {
    agentError = 'Agent service not configured';
  }

  // ── 3. On agent failure: flip to agent_error + FYI email ──
  // L6 (2026-04-19): cron/process-audit-queue.js Step 0.5 auto-retries rows
  // in status='agent_error' on a 5-min backoff. The FYI email is intentional
  // observability — not action-required — since retry is automatic.
  if (!agentTriggered && agentError) {
    console.error('[entity-audit-trigger] Agent trigger failed:', agentError, '- cron will auto-retry');

    // FYI notification (non-blocking).
    try {
      var resendKey = process.env.RESEND_API_KEY;
      if (resendKey) {
        await fetchT('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + resendKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: 'Moonraker Notifications <notifications@clients.moonraker.ai>',
            to: ['notifications@clients.moonraker.ai'],
            subject: 'Entity Audit Agent Error (auto-retrying) - ' + brandQuery,
            html:
              '<p>A new entity audit was submitted; the agent errored on first try. Cron will auto-retry every 30 min until it succeeds.</p>' +
              '<p><strong>Contact:</strong> ' + escapeHtml((contact.first_name || '') + ' ' + (contact.last_name || '')) + '</p>' +
              '<p><strong>Practice:</strong> ' + escapeHtml(brandQuery) + '</p>' +
              '<p><strong>Error:</strong> ' + escapeHtml(String(agentError)) + '</p>' +
              '<p><a href="https://clients.moonraker.ai/admin/clients">View in Admin</a></p>'
          })
        }, 10000);
      }
    } catch (notifyErr) {
      console.error('[entity-audit-trigger] FYI email failed:', notifyErr && notifyErr.message);
    }

    // Flip to agent_error so cron/process-audit-queue.js picks it up.
    try {
      await sb.mutate('entity_audits?id=eq.' + auditId, 'PATCH', {
        status: 'agent_error',
        last_agent_error: String(agentError || 'Unknown error').substring(0, 500),
        last_agent_error_at: new Date().toISOString()
      }, 'return=minimal');
    } catch (patchErr) {
      console.error('[entity-audit-trigger] agent_error flip failed:', patchErr && patchErr.message);
    }
  }

  return {
    audit_id: auditId,
    agent_triggered: agentTriggered,
    agent_error: agentError || undefined
  };
}

// Minimal HTML-escape for the FYI email body. The email helper ecosystem
// has email.p() / email.pRaw() for the real templating, but for a plain-text
// notification we only need to neutralize < > & " ' so user-supplied
// practice names can't break out into markup.
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { createAndTriggerAudit };
