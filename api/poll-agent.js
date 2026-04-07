/**
 * /api/poll-agent.js
 * 
 * Polls the agent service for task status.
 * Proxies from Client HQ browser to agent so we don't expose agent URL/key to the client.
 * 
 * GET ?task_id=xxx
 */

module.exports = async function(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var AGENT_URL = process.env.AGENT_SERVICE_URL;
  var AGENT_KEY = process.env.AGENT_API_KEY;

  if (!AGENT_URL || !AGENT_KEY) {
    return res.status(500).json({ error: 'Agent service not configured' });
  }

  var taskId = req.query.task_id;
  if (!taskId) {
    return res.status(400).json({ error: 'task_id query parameter required' });
  }

  try {
    var resp = await fetch(AGENT_URL + '/tasks/' + taskId + '/status', {
      headers: { 'Authorization': 'Bearer ' + AGENT_KEY }
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ error: 'Agent returned ' + resp.status });
    }

    var data = await resp.json();
    return res.status(200).json(data);

  } catch (err) {
    console.error('poll-agent error:', err);
    return res.status(502).json({ error: 'Could not reach agent service' });
  }
};
