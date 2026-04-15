// /api/newsletter-regenerate-quickwins.js
// Regenerates 4 quick wins based on the current 5 story headlines/bodies.
// POST { newsletter_id }

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    var user = await auth.requireAdmin(req, res);
    if (!user) return;

    var anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

    var body = req.body || {};
    var stories = body.stories || [];
    if (!stories.length) return res.status(400).json({ error: 'stories array required (headline + body for each)' });

    var storySummary = stories.map(function(s, i) {
      return (i + 1) + '. ' + (s.headline || '') + '\n   ' + (s.body || '').replace(/<[^>]*>/g, ' ').substring(0, 150);
    }).join('\n\n');

    var aiResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        temperature: 0.4,
        messages: [{
          role: 'user',
          content: 'Based on these 5 newsletter stories for therapy practice owners, write exactly 4 Quick Wins. Each is a single actionable sentence a therapist can do this week. Do NOT use em dashes. Do NOT include emojis.\n\n' + storySummary + '\n\nReturn ONLY a JSON array of 4 strings, no markdown: ["win 1","win 2","win 3","win 4"]'
        }]
      })
    });

    if (!aiResp.ok) return res.status(500).json({ error: 'Anthropic error: ' + aiResp.status });

    var aiData = await aiResp.json();
    var rawText = (aiData.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
    rawText = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    var js = rawText.indexOf('[');
    var je = rawText.lastIndexOf(']');
    if (js < 0 || je <= js) return res.status(500).json({ error: 'No JSON array in response' });

    var wins = JSON.parse(rawText.substring(js, je + 1));

    // Strip em dashes
    wins = wins.map(function(w) { return (w || '').replace(/\u2014/g, ', ').replace(/\u2013/g, ', ').replace(/—/g, ', '); });

    return res.status(200).json({ success: true, quick_wins: wins });
  } catch (e) {
    return res.status(500).json({ error: 'Quick wins generation failed: ' + e.message });
  }
};
