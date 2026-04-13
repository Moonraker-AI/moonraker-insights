// api/_lib/newsletter-template.js
// Newsletter email template builder for Moonraker weekly newsletter.
// Produces table-based HTML optimized for email clients (Outlook, Gmail, Apple Mail).
//
// Usage:
//   var nl = require('./_lib/newsletter-template');
//   var html = nl.build(newsletter, subscriberId);
//   var blogHtml = nl.buildBlog(newsletter);
//
// Content JSONB structure expected:
//   {
//     stories: [{ headline, body, action_items, image_url, image_alt }],
//     quick_wins: ["item1", "item2", ...],
//     spotlight: { headline, body, cta_text } | null,
//     final_thoughts: "text"
//   }

var ASSETS_BASE = 'https://clients.moonraker.ai/assets';
var LOGO_URL = ASSETS_BASE + '/logo.png';
var PARTNER_LOGOS_URL = ASSETS_BASE + '/newsletter/partner-logos.png';
var GOOGLE_RATING_URL = ASSETS_BASE + '/newsletter/google-rating.png';
var GOOGLE_PARTNER_URL = ASSETS_BASE + '/newsletter/google-partner.png';
var GOOGLE_LOCAL_GUIDES_URL = ASSETS_BASE + '/newsletter/google-local-guides.png';
var UNSUBSCRIBE_BASE = 'https://clients.moonraker.ai/api/newsletter-unsubscribe';

// ---- HTML escape ----
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Color palette (email-safe, matches brand) ----
var C = {
  navy: '#141C3A',
  white: '#FFFFFF',
  bg: '#F5F5F0',
  primary: '#00D47E',
  heading: '#1E2A5E',
  body: '#333F70',
  muted: '#6B7599',
  border: '#E2E8F0',
  subtleBg: '#F0FAF5',
  lightGreen: '#DDF8F2'
};

// ---- Font stacks (email-safe) ----
var F = {
  heading: "Outfit, 'Trebuchet MS', Arial, sans-serif",
  body: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"
};

// ---- Reusable email components ----

function divider() {
  return '<tr><td style="padding:0;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table>' +
  '</td></tr>';
}

function storyBlock(story, index) {
  var num = index + 1;
  var imageHtml = '';
  if (story.image_url) {
    imageHtml = '<tr><td style="padding:0 0 16px;">' +
      '<img src="' + esc(story.image_url) + '" alt="' + esc(story.image_alt || story.headline) + '" ' +
      'width="536" style="display:block;width:100%;max-width:536px;height:auto;border-radius:8px;" />' +
      '</td></tr>';
  }

  // Process action items
  var actionHtml = '';
  if (story.action_items || story.actions) {
    var items = story.action_items || story.actions;
    if (typeof items === 'string') {
      // Split on newlines for multi-line action items
      var lines = items.split('\n').filter(function(l) { return l.trim(); });
      if (lines.length > 1) {
        actionHtml = lines.map(function(item) {
          return '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.6;margin:0 0 4px;">' +
            '<strong style="color:' + C.heading + ';">' + item.split(':')[0] + (item.indexOf(':') > -1 ? ':</strong> ' + item.split(':').slice(1).join(':').trim() : '</strong>') + '</p>';
        }).join('');
      } else {
        actionHtml = '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0;">' + items + '</p>';
      }
    } else if (Array.isArray(items)) {
      actionHtml = '<ul style="margin:0;padding:0 0 0 20px;">' + items.map(function(item) {
        return '<li style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.6;margin:0 0 4px;">' + item + '</li>';
      }).join('') + '</ul>';
    }
  }

  return '<tr><td style="padding:0 0 8px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Story image
    imageHtml +

    // Numbered headline
    '<tr><td style="padding:0 0 12px;">' +
      '<h2 style="font-family:' + F.heading + ';font-size:22px;font-weight:700;color:' + C.heading + ';margin:0;line-height:1.3;">' +
        num + '. ' + (story.headline || '') +
      '</h2>' +
    '</td></tr>' +

    // Body paragraphs (already HTML from AI)
    '<tr><td style="padding:0 0 16px;">' +
      '<div style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;">' +
        (story.body || '') +
      '</div>' +
    '</td></tr>' +

    // Action section with green left border
    (actionHtml ? '<tr><td style="padding:14px 20px;background:' + C.subtleBg + ';border-left:3px solid ' + C.primary + ';border-radius:0 8px 8px 0;">' +
      '<p style="font-family:' + F.body + ';font-size:15px;font-weight:600;color:' + C.heading + ';margin:0 0 8px;">\u{1F449} Action:</p>' +
      actionHtml +
    '</td></tr>' : '') +

    '</table>' +
  '</td></tr>' +

  // Divider between stories
  '<tr><td style="padding:16px 0;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table>' +
  '</td></tr>';
}

function quickWinsBlock(items) {
  if (!items || !items.length) return '';
  var listHtml = '<ul style="margin:0;padding:0 0 0 20px;">' + items.map(function(item) {
    return '<li style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0 0 6px;">' + item + '</li>';
  }).join('') + '</ul>';

  return '<tr><td style="padding:0 0 8px;">' +
    '<h2 style="font-family:' + F.heading + ';font-size:22px;font-weight:700;color:' + C.heading + ';margin:0 0 14px;">\u2705 Quick Wins for This Week</h2>' +
    listHtml +
  '</td></tr>' +
  '<tr><td style="padding:16px 0;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table>' +
  '</td></tr>';
}

function spotlightBlock(spotlight) {
  // Accept either a custom spotlight object or use the default Engage spotlight
  var headline = '\u{1F680} Spotlight: Engage (Moonraker\'s New AI Project)';
  var body = '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0 0 12px;">' +
    '<strong>Engage is now ready for beta testers.</strong> We\'re looking for therapists who want to try a HIPAA-compliant AI chatbot built specifically for therapy practices. ' +
    '<strong>Engage</strong> handles FAQs, helps potential clients book consultations, and keeps your practice responsive around the clock, even when you\'re in session.' +
    '</p>' +
    '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0 0 12px;">' +
    'This beta is not yet HIPAA-compliant, so no client health information will be processed during testing. What we\'re looking for is your feedback on the experience: Does the chatbot sound right? Does it answer the way your practice would? Does it make booking easier for potential clients?' +
    '</p>';
  var cta = '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.heading + ';line-height:1.7;margin:0;font-weight:600;">' +
    '\u{1F449} <strong>Interested in being one of the first testers?</strong> Just reply to this email with "ENGAGE"' +
    '</p>';

  if (spotlight && spotlight.headline) {
    headline = spotlight.headline;
    body = '<div style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;">' + (spotlight.body || '') + '</div>';
    cta = spotlight.cta_text ? '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.heading + ';line-height:1.7;margin:12px 0 0;font-weight:600;">' + spotlight.cta_text + '</p>' : '';
  }

  return '<tr><td style="padding:0 0 8px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.lightGreen + ';border-radius:8px;">' +
      '<tr><td style="padding:24px;">' +
        '<h2 style="font-family:' + F.heading + ';font-size:22px;font-weight:700;color:' + C.heading + ';margin:0 0 14px;">' + headline + '</h2>' +
        body +
        cta +
      '</td></tr>' +
    '</table>' +
  '</td></tr>' +
  '<tr><td style="padding:16px 0;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>' +
      '<td style="border-top:1px solid ' + C.border + ';font-size:0;height:1px;line-height:0;">&nbsp;</td>' +
    '</tr></table>' +
  '</td></tr>';
}

function finalThoughtsBlock(text) {
  if (!text) return '';
  return '<tr><td style="padding:0 0 24px;">' +
    '<h2 style="font-family:' + F.heading + ';font-size:22px;font-weight:700;color:' + C.heading + ';margin:0 0 14px;">\u{1F64F} Final Thoughts</h2>' +
    '<div style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;">' +
      text +
    '</div>' +
  '</td></tr>';
}

function signatureBlock() {
  return '<tr><td style="padding:8px 0 0;">' +
    '<p style="font-family:' + F.body + ';font-size:15px;font-style:italic;color:' + C.body + ';line-height:1.7;margin:0 0 4px;">To your growth and success,</p>' +
    '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.heading + ';margin:0;line-height:1.5;">' +
      '<strong>Scott Pope</strong> - Director of Growth &amp; Operations, ' +
      '<a href="https://moonraker.ai" style="color:' + C.primary + ';text-decoration:none;">Moonraker.AI</a>' +
    '</p>' +
  '</td></tr>';
}

function googleBadgesRow() {
  return '<tr><td style="padding:20px 0 12px;text-align:center;">' +
    '<table cellpadding="0" cellspacing="0" border="0" align="center"><tr>' +
      '<td style="padding:0 12px;vertical-align:middle;">' +
        '<img src="' + GOOGLE_RATING_URL + '" alt="Google Rating 4.9" height="56" style="display:inline-block;height:56px;width:auto;" />' +
      '</td>' +
      '<td style="padding:0 12px;vertical-align:middle;">' +
        '<img src="' + GOOGLE_PARTNER_URL + '" alt="Google Partner" height="42" style="display:inline-block;height:42px;width:auto;" />' +
      '</td>' +
      '<td style="padding:0 12px;vertical-align:middle;">' +
        '<img src="' + GOOGLE_LOCAL_GUIDES_URL + '" alt="Google Local Guides" height="32" style="display:inline-block;height:32px;width:auto;" />' +
      '</td>' +
    '</tr></table>' +
  '</td></tr>';
}

// ---- Main build function ----

function build(newsletter, subscriberId) {
  var content = newsletter.content || {};
  var stories = content.stories || [];
  var quickWins = content.quick_wins || [];
  var finalThoughts = content.final_thoughts || '';
  var spotlight = content.spotlight || null;
  var year = new Date().getFullYear();

  // Build unsubscribe URL
  var unsubUrl = UNSUBSCRIBE_BASE + (subscriberId ? '?sid=' + subscriberId : '');

  // Stories HTML
  var storiesHtml = stories.map(function(s, i) { return storyBlock(s, i); }).join('');

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">' +
    '<style>' +
    '@import url("https://fonts.googleapis.com/css2?family=Outfit:wght@700&family=Inter:wght@400;500;600&display=swap");' +
    'body { margin:0; padding:0; }' +
    'img { border:0; outline:none; text-decoration:none; }' +
    // Responsive images for mobile
    '@media only screen and (max-width:620px) {' +
      '.email-container { width:100% !important; }' +
      '.email-body { padding:20px 16px !important; }' +
      '.badge-cell { padding:4px 6px !important; }' +
      '.badge-cell img { height:auto !important; max-height:40px !important; }' +
    '}' +
    '</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background:' + C.bg + ';font-family:' + F.body + ';">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:' + C.bg + ';">' +
    '<tr><td align="center" style="padding:24px 16px;">' +
    '<table class="email-container" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:' + C.white + ';border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.06);">' +

    // ==== HEADER: Logo centered on white bg ====
    '<tr><td style="padding:32px 32px 24px;text-align:center;">' +
      '<img src="' + LOGO_URL + '" alt="Moonraker.AI" height="48" style="display:inline-block;height:48px;width:auto;" />' +
    '</td></tr>' +

    // ==== BODY ====
    '<tr><td class="email-body" style="padding:0 32px 32px;">' +
    '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

    // Intro text
    '<tr><td style="padding:0 0 20px;">' +
      '<p style="font-family:' + F.body + ';font-size:15px;color:' + C.body + ';line-height:1.7;margin:0;text-align:center;">' +
        'We know running a therapy practice is more than sessions. It\'s managing visibility, trust, and compliance in a digital-first world. ' +
        'At Moonraker, we\'re here to make that easier, so every week you\'ll get a short, practical update on SEO + AI trends that affect therapists across the U.S. and Canada.' +
      '</p>' +
    '</td></tr>' +

    // Divider
    divider() +

    // Partner logos (composite image)
    '<tr><td style="padding:20px 0;text-align:center;">' +
      '<img src="' + PARTNER_LOGOS_URL + '" alt="Trusted by leading therapy business coaches" ' +
        'width="536" style="display:block;width:100%;max-width:536px;height:auto;margin:0 auto;" />' +
    '</td></tr>' +

    // Divider
    divider() +

    // Spacer before stories
    '<tr><td style="padding:12px 0 0;">&nbsp;</td></tr>' +

    // Stories
    storiesHtml +

    // Quick Wins
    quickWinsBlock(quickWins) +

    // Spotlight (optional)
    (spotlight !== false ? spotlightBlock(spotlight) : '') +

    // Final Thoughts
    finalThoughtsBlock(finalThoughts) +

    // Signature
    signatureBlock() +

    '</table></td></tr>' +

    // ==== FOOTER ====
    '<tr><td style="padding:0 32px 24px;text-align:center;">' +
      '<table cellpadding="0" cellspacing="0" border="0" width="100%">' +

      // Divider
      '<tr><td style="border-top:1px solid ' + C.primary + ';font-size:0;height:1px;line-height:0;">&nbsp;</td></tr>' +

      // Google badges row
      googleBadgesRow() +

      // Copyright + address
      '<tr><td style="padding:8px 0;text-align:center;">' +
        '<p style="font-family:' + F.body + ';font-size:12px;color:' + C.muted + ';margin:0 0 4px;line-height:1.6;">' +
          '&copy;' + year + ' <a href="https://moonraker.ai" style="color:' + C.primary + ';text-decoration:none;">Moonraker.AI</a>' +
        '</p>' +
        '<p style="font-family:' + F.body + ';font-size:12px;color:' + C.muted + ';margin:0;line-height:1.6;">' +
          '119 Oliver St, Easthampton, MA 01027' +
        '</p>' +
      '</td></tr>' +

      // Unsubscribe
      '<tr><td style="padding:12px 0 0;text-align:center;">' +
        '<p style="font-family:' + F.body + ';font-size:11px;color:#999;margin:0;line-height:1.6;">' +
          'You\'re receiving this because you attended one of our webinars, signed up for our services, or inquired about working with Moonraker. ' +
          'To unsubscribe, <a href="' + esc(unsubUrl) + '" style="color:' + C.muted + ';text-decoration:underline;">click here</a> ' +
          '&ndash; though you\'ll miss out on the SEO and compliance updates that keep your practice ahead of the curve.' +
        '</p>' +
      '</td></tr>' +

      '</table>' +
    '</td></tr>' +

    '</table></td></tr></table></body></html>';
}

// ---- Blog version (for moonraker.ai/blog) ----

function buildBlog(newsletter) {
  var content = newsletter.content || {};
  var stories = content.stories || [];
  var quickWins = content.quick_wins || [];
  var finalThoughts = content.final_thoughts || '';

  var storiesHtml = stories.map(function(s, i) {
    var num = i + 1;
    var img = s.image_url ? '<img src="' + esc(s.image_url) + '" alt="' + esc(s.image_alt || s.headline) + '" style="width:100%;border-radius:8px;margin-bottom:1rem;" />' : '';
    var actionHtml = '';
    if (s.action_items || s.actions) {
      var raw = s.action_items || s.actions;
      var items = typeof raw === 'string' ? raw.split('\n').filter(function(l) { return l.trim(); }) : (raw || []);
      actionHtml = '<div class="action-box"><p><strong>\u{1F449} Action:</strong></p>' +
        '<ul>' + items.map(function(item) { return '<li>' + item + '</li>'; }).join('') + '</ul>' +
        '</div>';
    }
    return '<article class="story">' + img +
      '<h2>' + num + '. ' + esc(s.headline) + '</h2>' +
      '<div class="story-body">' + (s.body || '') + '</div>' +
      actionHtml +
      '</article>';
  }).join('');

  var quickWinsHtml = quickWins.length
    ? '<section class="quick-wins"><h2>\u2705 Quick Wins for This Week</h2><ul>' +
      quickWins.map(function(w) { return '<li>' + w + '</li>'; }).join('') +
      '</ul></section>'
    : '';

  var finalHtml = finalThoughts
    ? '<section class="final-thoughts"><h2>\u{1F64F} Final Thoughts</h2><div>' + finalThoughts + '</div></section>'
    : '';

  return storiesHtml + quickWinsHtml + finalHtml +
    '<p class="signature">To your growth and success,<br><em>Scott Pope, Director of Growth &amp; Operations, Moonraker.AI</em></p>';
}

// ---- Exports ----

module.exports = {
  build: build,
  buildBlog: buildBlog,
  esc: esc,
  C: C,
  F: F
};
