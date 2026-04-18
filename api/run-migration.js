// api/_admin/run-migration.js
// Run a SQL migration file from migrations/ in the repo against the
// connected Postgres database.
//
// Reusable for any future migration. Auth-gated by CRON_SECRET.
//
// Usage:
//   POST /api/_admin/run-migration
//   Authorization: Bearer <CRON_SECRET>
//   Body: { "migration": "2026-04-17-attribution-tables.sql", "dry_run": false }
//
// Returns:
//   {
//     migration: string,
//     statements_run: number,
//     duration_ms: number,
//     verification: [{table, count} ...]   // sample queries to confirm
//   }
//
// Security:
//   - Fails closed if CRON_SECRET env var is missing
//   - Fails closed if migration filename has any path-traversal characters
//   - Migration file must exist at /migrations/<name>.sql in the repo
//   - Runs the file in a single transaction (BEGIN/COMMIT) so partial
//     failures don't leave the schema in an inconsistent state

var nodeCrypto = require('crypto');
var pg = require('pg');
var monitor = require('./_lib/monitor');

function constantTimeEqual(a, b) {
  if (!a || !b) return false;
  var bufA = Buffer.from(String(a));
  var bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return nodeCrypto.timingSafeEqual(bufA, bufB);
}

// Intentionally uses raw `fetch` against the GitHub REST API instead of
// routing through `api/_lib/github.js` (M40, 2026-04-19). Three reasons:
//   1. CRON_SECRET-gated handler with no user-input reachability
//   2. Read-only — no writes, no upsert SHA dance, no write-path surface
//   3. Filename already regex-validated at the caller (L80 below) as
//      /^[a-zA-Z0-9_.-]+\.sql$/ — stricter than `validatePath`'s
//      allowlist would be, and `migrations/` is not a wrapper-managed
//      prefix (no other code writes there). Expanding the wrapper's
//      write surface to cover this single read would weaken the
//      "wrapper only writes where writes happen" invariant.
async function fetchMigrationFromGitHub(filename) {
  var token = process.env.GITHUB_PAT;
  if (!token) throw new Error('GITHUB_PAT env var missing');
  var url = 'https://api.github.com/repos/Moonraker-AI/client-hq/contents/migrations/' + encodeURIComponent(filename);
  var resp = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'moonraker-migration-runner'
    }
  });
  if (!resp.ok) {
    throw new Error('GitHub fetch failed: ' + resp.status + ' ' + (await resp.text()).slice(0, 200));
  }
  var data = await resp.json();
  return Buffer.from(data.content, 'base64').toString('utf8');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Auth
  var expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'CRON_SECRET not configured' });
    return;
  }
  var authHeader = req.headers['authorization'] || '';
  var match = authHeader.match(/^Bearer\s+(.+)$/);
  if (!match || !constantTimeEqual(match[1], expected)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  var body = req.body || {};
  var migration = String(body.migration || '');
  var dryRun = !!body.dry_run;

  // Path-traversal guard: only allow [a-zA-Z0-9_.-] and require .sql extension
  if (!migration.match(/^[a-zA-Z0-9_.-]+\.sql$/)) {
    res.status(400).json({ error: 'Invalid migration filename' });
    return;
  }

  var dbUrl = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!dbUrl) {
    res.status(500).json({ error: 'POSTGRES_URL_NON_POOLING not configured' });
    return;
  }

  var t0 = Date.now();
  try {
    var sql = await fetchMigrationFromGitHub(migration);

    if (dryRun) {
      res.status(200).json({
        migration: migration,
        dry_run: true,
        sql_length: sql.length,
        sql_preview: sql.slice(0, 500)
      });
      return;
    }

    var client = new pg.Client({
      connectionString: dbUrl.replace(/[?&]sslmode=[^&]*/g, ''),
      ssl: { rejectUnauthorized: false }
    });
    await client.connect();

    var result;
    try {
      // Run as a single transaction. The migration file may contain
      // its own BEGIN/COMMIT inside DO blocks, but pg can handle nested
      // savepoints if needed. We use a top-level transaction so that any
      // failure rolls back the whole file.
      await client.query('BEGIN');
      result = await client.query(sql);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(function() {});
      await client.end();
      throw e;
    }

    // Verification queries: row counts on tables the migration may have
    // created or seeded. Lookup gracefully — these may not exist.
    var verification = [];
    for (var table of ['client_attribution_periods', 'client_attribution_sources']) {
      try {
        var r = await client.query('SELECT COUNT(*)::int AS c FROM ' + table);
        verification.push({ table: table, count: r.rows[0].c });
      } catch (e) {
        monitor.logError('run-migration', e, {
          detail: { stage: 'verify_table', table: table, migration: migration }
        });
        verification.push({ table: table, error: 'Verification failed' });
      }
    }

    await client.end();

    res.status(200).json({
      migration: migration,
      ok: true,
      duration_ms: Date.now() - t0,
      verification: verification
    });
  } catch (e) {
    monitor.logError('run-migration', e, {
      detail: { stage: 'run_handler', migration: (typeof migration !== 'undefined' ? migration : null) }
    });
    res.status(500).json({
      error: 'Migration failed',
      duration_ms: Date.now() - t0
    });
  }
};
