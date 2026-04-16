// api/_lib/github.js
// Shared GitHub API helpers for file operations.
// Used by routes that deploy client pages, delete files, or read templates.
//
// Usage:
//   var gh = require('./_lib/github');
//   var { content, sha } = await gh.readFile('anna-skomorovskaia/proposal/index.html');
//   var html = await gh.readTemplate('proposal.html');
//   await gh.pushFile('anna-skomorovskaia/report/index.html', html, 'Deploy report');
//   await gh.deleteFile('old-client/proposal/index.html', sha, 'Cleanup');

var REPO = 'Moonraker-AI/client-hq';
var BRANCH = 'main';
var API_BASE = 'https://api.github.com/repos/' + REPO + '/contents/';

function token() {
  var t = process.env.GITHUB_PAT;
  if (!t) throw new Error('GITHUB_PAT not configured');
  return t;
}

function headers() {
  return {
    'Authorization': 'Bearer ' + token(),
    'Accept': 'application/vnd.github+json'
  };
}

function validatePath(p) {
  if (!p || p.indexOf('..') !== -1 || p.startsWith('/')) throw new Error('Invalid path: ' + p);
}

// Read a file from the repo. Returns { content: string, sha: string }.
async function readFile(path) {
  validatePath(path);
  var resp = await fetch(API_BASE + path + '?ref=' + BRANCH, { headers: headers() });
  if (!resp.ok) {
    var err = new Error('GitHub readFile failed (' + resp.status + '): ' + path);
    err.status = resp.status;
    throw err;
  }
  var data = await resp.json();
  return {
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
    sha: data.sha
  };
}

// Read a template from _templates/. Returns HTML string.
async function readTemplate(name) {
  var result = await readFile('_templates/' + name);
  return result.content;
}

// Get the SHA of a file, or null if it doesn't exist.
async function fileSha(path) {
  validatePath(path);
  var resp = await fetch(API_BASE + path + '?ref=' + BRANCH, { headers: headers() });
  if (!resp.ok) return null;
  var data = await resp.json();
  return data.sha;
}

// Create or update a file. If sha is provided, it's an update; otherwise creates new.
// If sha is not provided, checks if the file exists first (safe upsert).
async function pushFile(path, content, message, sha) {
  validatePath(path);
  // If no sha provided, check if file already exists
  if (!sha) {
    sha = await fileSha(path);
  }

  var body = {
    message: message || ('Update ' + path),
    content: Buffer.from(content, 'utf-8').toString('base64'),
    branch: BRANCH
  };
  if (sha) body.sha = sha;

  var resp = await fetch(API_BASE + path, {
    method: 'PUT',
    headers: Object.assign({}, headers(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    var errText = await resp.text();
    var err = new Error('GitHub pushFile failed (' + resp.status + '): ' + errText.substring(0, 500));
    err.status = resp.status;
    throw err;
  }

  var data = await resp.json();
  return { sha: data.content.sha, commit: data.commit.sha };
}

// Delete a file. Requires sha.
async function deleteFile(path, sha, message) {
  validatePath(path);
  if (!sha) {
    sha = await fileSha(path);
    if (!sha) return null; // File doesn't exist, nothing to delete
  }

  var resp = await fetch(API_BASE + path, {
    method: 'DELETE',
    headers: Object.assign({}, headers(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      message: message || ('Delete ' + path),
      sha: sha,
      branch: BRANCH
    })
  });

  if (!resp.ok) {
    var errText = await resp.text();
    var err = new Error('GitHub deleteFile failed (' + resp.status + '): ' + errText.substring(0, 500));
    err.status = resp.status;
    throw err;
  }

  return true;
}

// Check if GITHUB_PAT is set.
function isConfigured() {
  return !!process.env.GITHUB_PAT;
}

module.exports = { readFile, readTemplate, fileSha, pushFile, deleteFile, isConfigured };
