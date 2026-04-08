// /api/batch-create-drive.js
// Temporary batch endpoint: creates Google Drive folder hierarchies for multiple clients.
// POST { clients: [{ slug, contact_id, practice_name }] }
// Does NOT change status or onboarding steps. Only creates folders + updates drive_folder_id/url.

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });
  if (!saJson) return res.status(500).json({ error: 'GOOGLE_SERVICE_ACCOUNT_JSON not configured' });

  var clients = req.body && req.body.clients;
  if (!clients || !Array.isArray(clients) || clients.length === 0) {
    return res.status(400).json({ error: 'clients array required' });
  }

  var CLIENTS_FOLDER_ID = '1dymrrowTe1szsOJJPf45x4qDUit6J5jB';
  var sbHeaders = {
    'apikey': sbKey,
    'Authorization': 'Bearer ' + sbKey,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  // Get a delegated Drive token once for all operations
  var driveToken;
  try {
    driveToken = await getDelegatedToken(saJson, 'support@moonraker.ai', 'https://www.googleapis.com/auth/drive');
    if (!driveToken || typeof driveToken !== 'string') {
      return res.status(500).json({ error: 'Failed to get Drive token', detail: driveToken });
    }
  } catch (e) {
    return res.status(500).json({ error: 'Drive auth failed: ' + e.message });
  }

  var driveHeaders = {
    'Authorization': 'Bearer ' + driveToken,
    'Content-Type': 'application/json'
  };

  var folderTree = [
    { name: 'Creative', children: ['Headshots', 'Logos', 'Pics', 'Vids', 'Other'] },
    { name: 'Docs', children: ['GBP Posts', 'Press Releases'] },
    { name: 'Optimization', children: [] },
    { name: 'Web Design', children: [] }
  ];

  var results = [];

  for (var c = 0; c < clients.length; c++) {
    var client = clients[c];
    var result = { slug: client.slug, practice_name: client.practice_name, status: 'pending' };

    try {
      // Create parent folder
      var parentFolder = await createDriveFolder(client.practice_name, CLIENTS_FOLDER_ID, driveHeaders);
      if (!parentFolder || !parentFolder.id) {
        result.status = 'error';
        result.error = 'Failed to create parent folder: ' + JSON.stringify(parentFolder);
        results.push(result);
        continue;
      }
      result.parent_id = parentFolder.id;

      var creativeFolderId = null;
      var createdSubs = [];

      for (var f = 0; f < folderTree.length; f++) {
        var node = folderTree[f];
        var subFolder = await createDriveFolder(node.name, parentFolder.id, driveHeaders);
        if (subFolder && subFolder.id) {
          createdSubs.push(node.name);
          if (node.name === 'Creative') creativeFolderId = subFolder.id;

          for (var ch = 0; ch < node.children.length; ch++) {
            var childFolder = await createDriveFolder(node.children[ch], subFolder.id, driveHeaders);
            if (childFolder && childFolder.id) {
              createdSubs.push(node.name + '/' + node.children[ch]);
            }
          }
        }
      }

      result.subfolders = createdSubs;
      result.creative_folder_id = creativeFolderId;

      // Update Supabase
      if (creativeFolderId && client.contact_id) {
        var patchResp = await fetch(sbUrl + '/rest/v1/contacts?id=eq.' + client.contact_id, {
          method: 'PATCH',
          headers: sbHeaders,
          body: JSON.stringify({
            drive_folder_id: creativeFolderId,
            drive_folder_url: 'https://drive.google.com/drive/folders/' + creativeFolderId
          })
        });
        result.supabase_updated = patchResp.ok;
      }

      result.status = 'success';
      result.drive_url = 'https://drive.google.com/drive/folders/' + creativeFolderId;
    } catch (err) {
      result.status = 'error';
      result.error = err.message || String(err);
    }

    results.push(result);
  }

  return res.status(200).json({ success: true, results: results });
};


async function getDelegatedToken(saJson, impersonateEmail, scope) {
  var sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  if (!sa.private_key || !sa.client_email) {
    throw new Error('SA JSON missing private_key or client_email');
  }
  var crypto = require('crypto');
  var header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  var now = Math.floor(Date.now() / 1000);
  var claims = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    sub: impersonateEmail,
    scope: scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');
  var signable = header + '.' + claims;
  var signer = crypto.createSign('RSA-SHA256');
  signer.update(signable);
  var signature = signer.sign(sa.private_key, 'base64url');
  var jwt = signable + '.' + signature;
  var tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt
  });
  var tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    throw new Error(tokenData.error_description || tokenData.error || JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}


async function createDriveFolder(name, parentId, headers) {
  var resp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({
      name: name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    })
  });
  if (!resp.ok) {
    var errBody = await resp.text();
    return { error: 'Drive API ' + resp.status + ': ' + errBody };
  }
  return await resp.json();
}
