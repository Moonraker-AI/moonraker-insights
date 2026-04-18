// /api/cron/process-scheduled-sends.js
// Runs every 5 minutes via Vercel Cron.
// Finds newsletters with status='scheduled' and scheduled_at <= now, then sends them.

var auth = require('../_lib/auth');
var sb = require('../_lib/supabase');
var monitor = require('../_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth: admin JWT, CRON_SECRET, or AGENT_API_KEY (timing-safe)
  var user = await auth.requireAdminOrInternal(req, res);
  if (!user) return;

  try {
    var now = new Date().toISOString();
    var scheduled = await sb.query(
      'newsletters?status=eq.scheduled&scheduled_at=lte.' + now + '&select=id,edition_number,scheduled_at&limit=5'
    );

    if (!scheduled || scheduled.length === 0) {
      return res.status(200).json({ message: 'No scheduled sends due', checked_at: now });
    }

    var results = [];
    for (var i = 0; i < scheduled.length; i++) {
      var nl = scheduled[i];
      console.log('Processing scheduled send: Edition #' + nl.edition_number + ' (scheduled for ' + nl.scheduled_at + ')');

      try {
        var baseUrl = 'https://' + (req.headers.host || 'clients.moonraker.ai');
        var sendResp = await fetch(baseUrl + '/api/send-newsletter', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cronSecret
          },
          body: JSON.stringify({ newsletter_id: nl.id, tier: 'all' })
        });

        var sendData = await sendResp.json();
        if (!sendResp.ok) {
          console.error('Scheduled send failed for Edition #' + nl.edition_number + ':', sendData.error);
          await sb.mutate('newsletters?id=eq.' + nl.id, 'PATCH', {
            status: 'failed',
            updated_at: new Date().toISOString()
          });
          results.push({ edition: nl.edition_number, status: 'failed', error: sendData.error });
        } else {
          results.push({ edition: nl.edition_number, status: 'sent', sent: sendData.sent });
        }
      } catch (e) {
        console.error('Scheduled send error for Edition #' + nl.edition_number + ':', e.message);
        monitor.logError('cron/process-scheduled-sends', e, {
          detail: { stage: 'send_per_edition', edition: nl.edition_number }
        });
        results.push({ edition: nl.edition_number, status: 'error', error: 'Send failed' });
      }
    }

    return res.status(200).json({ processed: results.length, results: results });
  } catch (e) {
    console.error('process-scheduled-sends FATAL:', e.message);
    monitor.logError('cron/process-scheduled-sends', e, {
      detail: { stage: 'cron_handler' }
    });
    return res.status(500).json({ error: 'Scheduled sends processing failed' });
  }
};
