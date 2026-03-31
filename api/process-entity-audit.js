// /api/process-entity-audit.js
// Processes pasted Surge data into a structured entity audit scorecard.
// 1. Sends Surge data to Claude for structured extraction
// 2. Updates entity_audits row in Supabase with scores + tasks
// 3. Deploys scorecard page from template to GitHub
// 4. Flips status to delivered

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var anthropicKey = process.env.ANTHROPIC_API_KEY;
  var ghToken = process.env.GITHUB_PAT;
  var sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  var sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';

  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!ghToken) return res.status(500).json({ error: 'GITHUB_PAT not configured' });
  if (!sbKey) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY not configured' });

  var body = req.body;
  var auditId = body.audit_id;
  var surgeData = body.surge_data;

  if (!auditId || !surgeData) return res.status(400).json({ error: 'audit_id and surge_data required' });

  var REPO = 'Moonraker-AI/client-hq';
  var BRANCH = 'main';

  function sbHeaders() {
    return { 'apikey': sbKey, 'Authorization': 'Bearer ' + sbKey, 'Content-Type': 'application/json' };
  }

  try {
    // ============================================================
    // STEP 1: Look up audit + contact
    // ============================================================
    var auditResp = await fetch(sbUrl + '/rest/v1/entity_audits?id=eq.' + auditId + '&select=*', {
      headers: sbHeaders()
    });
    var audits = await auditResp.json();
    if (!audits || audits.length === 0) return res.status(404).json({ error: 'Audit not found' });
    var audit = audits[0];

    var contactResp = await fetch(sbUrl + '/rest/v1/contacts?id=eq.' + audit.contact_id + '&select=*', {
      headers: sbHeaders()
    });
    var contacts = await contactResp.json();
    if (!contacts || contacts.length === 0) return res.status(404).json({ error: 'Contact not found' });
    var contact = contacts[0];

    var practiceName = contact.practice_name || (contact.first_name + ' ' + contact.last_name).trim();
    var slug = contact.slug;

    // ============================================================
    // STEP 2: Call Claude to process Surge data
    // ============================================================
    var claudePrompt = `You are processing Surge audit data for an entity audit scorecard. The practice is "${practiceName}" at ${audit.homepage_url}.

Analyze the Surge data below and return ONLY a valid JSON object (no markdown, no backticks, no explanation) with this exact structure:

{
  "scores": {
    "credibility": <number 1-10>,
    "optimization": <number 1-10>,
    "reputation": <number 1-10>,
    "engagement": <number 1-10>,
    "variance": <number 0-100>,
    "variance_desc": "<one sentence describing the variance score meaning>",
    "summary": "<2-3 paragraphs of HTML summarizing the audit findings. Use <strong> for emphasis. Do not use em dashes. Focus on: what is working, what is the core challenge, and what the path forward looks like.>",
    "quick_wins": ["<quick win 1>", "<quick win 2>", "<quick win 3>", "<quick win 4>", "<quick win 5>"]
  },
  "tasks": {
    "credibility": [
      {
        "severity": "critical|warning|positive",
        "title": "<short finding title>",
        "detail": "<1-2 sentence explanation of the finding>",
        "fix": "<HTML with step-by-step DIY fix instructions. Use <p>, <ol class='step-list'><li>...</li></ol>, and <pre><code>...</code></pre> for schema examples. Include actual schema code snippets where relevant. Anonymize the practice name as [Practice Name] in code examples.>"
      }
    ],
    "optimization": [...],
    "reputation": [...],
    "engagement": [...]
  }
}

SCORING GUIDELINES:
- Credibility (1-10): Weighted from Entity Recognition, Knowledge Graph, Content Authenticity, DNS/directory presence, GBP status
- Optimization (1-10): Weighted from Topical Depth, AI Extraction Readiness, Structured Data Stack, FAQ Coverage, heading hierarchy
- Reputation (1-10): Weighted from Reputation Signal, Citation Gap, Unique Value Index, review visibility, endorsements
- Engagement (1-10): Weighted from Performance/UX, CTA clarity, booking pathway, content freshness
- Variance (0-100): Overall gap score. 0 = perfect, 100 = critical. Weight entity recognition gaps heavily.

SEVERITY RULES:
- "critical" = red dot, something broken or missing that blocks AI visibility
- "warning" = yellow dot, something suboptimal that limits performance
- "positive" = green dot, something that is working well

TASK RULES:
- Frame ALL tasks as DIY self-service: "Here is what to do" not "We will do this"
- Include actual schema code in fix instructions where relevant (brand.jsonld, AggregateRating, FAQPage, VideoObject, Service)
- Be specific with metric values from the Surge data
- Each pillar should have 3-6 findings (mix of critical, warning, and positive)
- Do not use em dashes anywhere

SURGE DATA:
${surgeData}`;

    var claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 8000,
        messages: [{ role: 'user', content: claudePrompt }]
      })
    });

    if (!claudeResp.ok) {
      var claudeErr = await claudeResp.text();
      return res.status(500).json({ error: 'Claude API error', detail: claudeErr });
    }

    var claudeData = await claudeResp.json();
    var rawText = claudeData.content.map(function(c) { return c.text || ''; }).join('');

    // Parse JSON from Claude's response (strip any markdown fences)
    var cleanJson = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var parsed;
    try {
      parsed = JSON.parse(cleanJson);
    } catch (parseErr) {
      return res.status(500).json({ error: 'Failed to parse Claude response as JSON', raw: cleanJson.substring(0, 500) });
    }

    // ============================================================
    // STEP 3: Update Supabase entity_audits row
    // ============================================================
    var updateBody = {
      scores: parsed.scores,
      tasks: parsed.tasks,
      surge_data: { raw_length: surgeData.length, processed_at: new Date().toISOString() },
      status: 'complete'
    };

    var updateResp = await fetch(sbUrl + '/rest/v1/entity_audits?id=eq.' + auditId, {
      method: 'PATCH',
      headers: Object.assign({}, sbHeaders(), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify(updateBody)
    });

    if (!updateResp.ok) {
      var updateErr = await updateResp.text();
      return res.status(500).json({ error: 'Supabase update failed', detail: updateErr });
    }

    // ============================================================
    // STEP 4: Deploy scorecard page from template to GitHub
    // ============================================================
    var ghHeaders = {
      'Authorization': 'Bearer ' + ghToken,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    };

    // Read the scorecard template
    var tmplResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/_templates/entity-audit.html?ref=' + BRANCH, {
      headers: ghHeaders
    });
    if (!tmplResp.ok) {
      return res.status(200).json({ success: true, warning: 'Supabase updated but template not found for GitHub deploy', scores: parsed.scores });
    }
    var tmplData = await tmplResp.json();

    // Check if destination exists
    var destPath = slug + '/entity-audit/index.html';
    var sha = null;
    var checkResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + destPath + '?ref=' + BRANCH, {
      headers: ghHeaders
    });
    if (checkResp.ok) {
      sha = (await checkResp.json()).sha;
    }

    // Push the template as the scorecard page
    var pushBody = {
      message: 'Deploy entity audit scorecard for ' + slug,
      content: tmplData.content.replace(/\n/g, ''),
      branch: BRANCH
    };
    if (sha) pushBody.sha = sha;

    var pushResp = await fetch('https://api.github.com/repos/' + REPO + '/contents/' + destPath, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(pushBody)
    });

    // ============================================================
    // STEP 5: Flip status to delivered
    // ============================================================
    await fetch(sbUrl + '/rest/v1/entity_audits?id=eq.' + auditId, {
      method: 'PATCH',
      headers: Object.assign({}, sbHeaders(), { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({ status: 'delivered' })
    });

    return res.status(200).json({
      success: true,
      scores: parsed.scores,
      task_counts: {
        credibility: (parsed.tasks.credibility || []).length,
        optimization: (parsed.tasks.optimization || []).length,
        reputation: (parsed.tasks.reputation || []).length,
        engagement: (parsed.tasks.engagement || []).length
      },
      scorecard_url: 'https://clients.moonraker.ai/' + slug + '/entity-audit',
      github_deployed: pushResp.ok
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
