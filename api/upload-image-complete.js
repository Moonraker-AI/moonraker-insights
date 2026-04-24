// /api/upload-image-complete.js
//
// Pagemaster v2 image upload — Step 2 of 2.
//
// Client calls this after the Storage PUT succeeds. We:
//   - Verify the pool row is in 'pending' state and matches the contact
//   - Mark metadata_json.upload_complete_at
//   - Leave status='pending' so the processing cron picks it up
//
// We do NOT set status='ready' here — the cron pipeline (EXIF strip, IPTC
// inject, alt text generation) runs first, then flips status='ready' or
// 'failed'. From the client's perspective, the file uploaded successfully
// and is now being processed.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');
var pageToken = require('./_lib/page-token');
var monitor = require('./_lib/monitor');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!sb.isConfigured()) return res.status(500).json({ error: 'Not configured' });

  var body = req.body || {};
  var poolId = body.pool_id;
  var contactId = body.contact_id;

  if (!poolId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(poolId)) {
    return res.status(400).json({ error: 'Invalid pool_id' });
  }
  if (!contactId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactId)) {
    return res.status(400).json({ error: 'Invalid contact_id' });
  }

  try {
    // Auth: page-token first (typical), admin fallback
    var tokenStr = pageToken.getTokenFromRequest(req, 'onboarding');
    var token = null;
    if (tokenStr) { try { token = pageToken.verify(tokenStr, 'onboarding'); } catch (_) { token = null; } }
    if (!token || token.contact_id !== contactId) {
      var admin = await auth.requireAdminOrInternal(req, res);
      if (!admin) return;
    }

    // Look up pool row + verify it matches contact + is pending
    var pool = await sb.one(
      'client_image_pool?id=eq.' + encodeURIComponent(poolId) +
      '&contact_id=eq.' + encodeURIComponent(contactId) +
      '&limit=1'
    );
    if (!pool) return res.status(404).json({ error: 'Pool row not found' });

    if (pool.status !== 'pending') {
      // Already processed or failed; idempotent return
      return res.status(200).json({
        pool_id: pool.id,
        status: pool.status,
        idempotent: true,
      });
    }

    // Mark upload as complete in metadata. Status stays 'pending' for cron.
    var metaPatch = Object.assign({}, pool.metadata_json || {}, {
      upload_complete_at: new Date().toISOString(),
    });

    await sb.mutate('client_image_pool?id=eq.' + pool.id, 'PATCH', {
      metadata_json: metaPatch,
    }, 'return=minimal');

    return res.status(200).json({
      pool_id: pool.id,
      status: 'pending',
      processing: true,
    });

  } catch (err) {
    monitor.logError('upload-image-complete', err, {
      detail: { stage: 'complete_handler', pool_id: poolId },
    });
    return res.status(500).json({ error: 'Upload completion failed' });
  }
};
