// api/_lib/email-template.js
// Shared email template for all Moonraker emails.
// Produces a premium branded layout matching the proposal page design:
//   - Dark navy (#141C3A) header bar with logo + context label
//   - White content body with subtle side borders
//   - Dark navy footer with copyright + link
//
// Usage:
//   var email = require('./_lib/email-template');
//   var html = email.wrap({
//     headerLabel: 'Growth Proposal',
//     // New safe p() escapes its input. Use pRaw() when you're building HTML.
//     content: email.greeting('Sarah') + email.p('Your proposal is ready.') + email.cta('https://...', 'View Proposal'),
//     year: 2026
//   });
//
// footerNote vs footerNoteRaw:
//   footerNote:    string is HTML-escaped before rendering (safe default).
//   footerNoteRaw: string is rendered as-is (for footers that contain links/styles).
//   If both are passed, footerNoteRaw wins.
//
// From address display names (standardized):
//   Moonraker Proposals <proposals@clients.moonraker.ai>
//   Moonraker Audits <audits@clients.moonraker.ai>
//   Moonraker Reports <reports@clients.moonraker.ai>
//   Moonraker Notifications <notifications@clients.moonraker.ai>

var LOGO_URL = 'https://clients.moonraker.ai/assets/logo.png';
var SITE_URL = 'https://moonraker.ai';
var CALENDAR_URL = 'https://msg.moonraker.ai/widget/bookings/scott-pope-calendar';

// ---- From addresses ----

var FROM = {
  proposals: 'Moonraker Proposals <proposals@clients.moonraker.ai>',
  audits: 'Moonraker Audits <audits@clients.moonraker.ai>',
  reports: 'Moonraker Reports <reports@clients.moonraker.ai>',
  notifications: 'Moonraker Notifications <notifications@clients.moonraker.ai>'
};

// ---- HTML escape ----

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Content helpers ----

function greeting(name) {
  return '<h1 style="font-family:Outfit,sans-serif;font-size:24px;font-weight:700;color:#1E2A5E;margin:0 0 16px;">Hi ' + esc(name) + ',</h1>';
}

// Renders text inside a <p> with HTML-escaping. Use this by default.
function p(text) {
  return '<p style="font-family:Inter,sans-serif;font-size:15px;color:#333F70;line-height:1.7;margin:0 0 16px;">' + esc(text) + '</p>';
}

// Renders text inside a <p> as raw HTML. Use only when caller is building HTML
// (e.g. concatenating <strong> tags, pre-escaped fragments, or &bull; entities).
function pRaw(text) {
  return '<p style="font-family:Inter,sans-serif;font-size:15px;color:#333F70;line-height:1.7;margin:0 0 16px;">' + text + '</p>';
}

function cta(url, text) {
  return '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0;"><tr><td align="center">' +
    '<a href="' + esc(url) + '" style="display:inline-block;background:#00D47E;color:#FFFFFF;font-family:Inter,sans-serif;font-weight:600;font-size:15px;text-decoration:none;padding:14px 32px;border-radius:8px;">' + esc(text) + '</a>' +
    '</td></tr></table>';
}

function secondaryCta(url, text) {
  return '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:20px 0;"><tr><td align="center">' +
    '<a href="' + esc(url) + '" style="display:inline-block;border:1px solid #00D47E;color:#00D47E;font-family:Inter,sans-serif;font-weight:600;font-size:14px;text-decoration:none;padding:10px 24px;border-radius:8px;">' + esc(text) + '</a>' +
    '</td></tr></table>';
}

function bookingButton(text) {
  return secondaryCta(CALENDAR_URL, text || 'Book a Call with Scott');
}

function divider() {
  return '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:8px 0;"><tr>' +
    '<td style="border-top:1px solid #E2E8F0;font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table>';
}

function sectionHeading(text) {
  return '<h2 style="font-family:Outfit,sans-serif;font-weight:700;font-size:18px;color:#1E2A5E;margin:8px 0 12px;">' + esc(text) + '</h2>';
}

// Score card row for CORE audit emails
// scores: { credibility: 3.2, optimization: 5.1, reputation: 2.8, engagement: 4.5 }
function coreScoreCards(scores) {
  var cred = scores.credibility || 0;
  var opt = scores.optimization || 0;
  var rep = scores.reputation || 0;
  var eng = scores.engagement || 0;
  var avg = ((cred + opt + rep + eng) / 4).toFixed(1);

  function cardColor(v) {
    if (v <= 3) return { bg: 'rgba(239,68,68,.06)', border: 'rgba(239,68,68,.18)', text: '#EF4444' };
    if (v <= 6) return { bg: 'rgba(245,158,11,.06)', border: 'rgba(245,158,11,.18)', text: '#F59E0B' };
    return { bg: 'rgba(0,212,126,.06)', border: 'rgba(0,212,126,.18)', text: '#00b86c' };
  }

  function card(value, label) {
    var c = cardColor(value);
    return '<td width="24%" style="background:' + c.bg + ';border:1px solid ' + c.border + ';border-radius:10px;padding:14px 8px;text-align:center;">' +
      '<div style="font-family:Outfit,sans-serif;font-weight:700;font-size:26px;color:' + c.text + ';">' + value + '</div>' +
      '<div style="font-family:Inter,sans-serif;font-size:10px;color:#6B7599;text-transform:uppercase;letter-spacing:.5px;margin-top:2px;">' + esc(label) + '</div>' +
      '</td>';
  }

  var spacer = '<td width="2%"></td>';

  return '<div style="font-family:Inter,sans-serif;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:#6B7599;margin-bottom:10px;text-align:center;">Your CORE Scores</div>' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:6px;"><tr>' +
    card(cred, 'Credibility') + spacer +
    card(opt, 'Optimization') + spacer +
    card(rep, 'Reputation') + spacer +
    card(eng, 'Engagement') +
    '</tr></table>' +
    '<div style="font-family:Inter,sans-serif;font-size:13px;color:#6B7599;text-align:center;margin-bottom:20px;">Average: ' + avg + '/10</div>';
}

// Stat card row for digest / summary emails
// items: [{ value: '5', label: 'New Leads', color: '#D97706', bg: 'rgba(245,158,11,.06)', border: 'rgba(245,158,11,.2)' }, ...]
function statCards(items) {
  var width = Math.floor(94 / items.length);
  var gap = Math.floor(6 / (items.length - 1));
  var html = '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px;"><tr>';
  items.forEach(function(item, i) {
    if (i > 0) html += '<td width="' + gap + '%"></td>';
    html += '<td width="' + width + '%" style="background:' + item.bg + ';border:1px solid ' + item.border + ';border-radius:10px;padding:12px 16px;text-align:center;">' +
      '<div style="font-family:Outfit,sans-serif;font-weight:700;font-size:24px;color:' + item.color + ';">' + esc(String(item.value)) + '</div>' +
      '<div style="font-family:Inter,sans-serif;font-size:10px;color:#6B7599;text-transform:uppercase;letter-spacing:.5px;">' + esc(item.label) + '</div>' +
      '</td>';
  });
  html += '</tr></table>';
  return html;
}

// ---- Main wrapper ----

function wrap(options) {
  var headerLabel = options.headerLabel || '';
  var content = options.content || '';
  // footerNoteRaw: raw HTML (use for footers with links/styles).
  // footerNote: plain text, escaped before rendering.
  // footerNoteRaw wins if both are present.
  var footerNoteRaw = options.footerNoteRaw || '';
  var footerNote = footerNoteRaw || (options.footerNote ? esc(options.footerNote) : '');
  var year = options.year || new Date().getFullYear();

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
    '<style>@import url("https://fonts.googleapis.com/css2?family=Outfit:wght@700&family=Inter:wght@400;500;600&display=swap");</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background:#F7FDFB;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F7FDFB;">' +
    '<tr><td align="center" style="padding:24px 16px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">' +

    // ---- Header: dark navy bar ----
    '<tr><td style="background:#141C3A;padding:24px 32px;border-radius:14px 14px 0 0;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
        '<td style="vertical-align:middle;"><img src="' + LOGO_URL + '" alt="Moonraker" height="28" style="display:block;"></td>' +
        (headerLabel
          ? '<td style="text-align:right;vertical-align:middle;"><span style="color:#FFFFFF;font-family:Inter,sans-serif;font-size:12px;letter-spacing:0.03em;">' + esc(headerLabel) + '</span></td>'
          : '') +
      '</tr></table>' +
    '</td></tr>' +

    // ---- Body: white content area ----
    '<tr><td style="background:#FFFFFF;padding:32px;border-left:1px solid #E2E8F0;border-right:1px solid #E2E8F0;">' +
      content +
    '</td></tr>' +

    // ---- Footer: dark navy bar ----
    '<tr><td style="background:#141C3A;padding:24px 32px;border-radius:0 0 14px 14px;text-align:center;">' +
      (footerNote
        ? '<p style="font-size:13px;color:rgba(232,245,239,.55);margin:0 0 12px;line-height:1.6;font-family:Inter,sans-serif;">' + footerNote + '</p>'
        : '') +
      '<p style="font-size:12px;color:rgba(232,245,239,.35);margin:0;font-family:Inter,sans-serif;">' +
        '&copy; ' + year + ' Moonraker AI' +
      '</p>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// ---- Exports ----

module.exports = {
  wrap: wrap,
  greeting: greeting,
  p: p,
  pRaw: pRaw,
  cta: cta,
  secondaryCta: secondaryCta,
  bookingButton: bookingButton,
  divider: divider,
  sectionHeading: sectionHeading,
  coreScoreCards: coreScoreCards,
  statCards: statCards,
  esc: esc,
  FROM: FROM,
  LOGO_URL: LOGO_URL,
  SITE_URL: SITE_URL,
  CALENDAR_URL: CALENDAR_URL
};
