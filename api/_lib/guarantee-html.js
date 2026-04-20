// /api/_lib/guarantee-html.js
// Server-side twin of shared/guarantee-content.js for the Performance
// Guarantee frozen-HTML snapshot written at sign time.
//
// IMPORTANT — KEEP IN SYNC:
//   The legal prose and table shape here MUST mirror
//   shared/guarantee-content.js byte-for-byte. The browser renders the
//   document via the shared module; when the client signs, this server-side
//   twin re-renders the same HTML and snapshots it into
//   signed_performance_guarantees.guarantee_terms_html so the exact text the
//   client agreed to is preserved verbatim in the database — even if the
//   shared module is later edited.
//
//   If you edit prose, a table row, or any visible string here, update
//   shared/guarantee-content.js in the same commit.

'use strict';

function _fmtCents(c) {
  if (c == null || isNaN(c)) return '$—';
  var d = c / 100;
  if (Number.isInteger(d)) {
    return '$' + d.toLocaleString('en-US');
  }
  return '$' + d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _fmtRate(r) {
  if (r == null || isNaN(r)) return '—';
  return Math.round(Number(r) * 100) + '%';
}

function _fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function _esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build the full pg-doc HTML. Pure function — no side effects.
// Matches window.buildGuaranteeHtml from shared/guarantee-content.js.
function buildGuaranteeHtml(pgRow, contactParam, opts) {
  var pg = pgRow || {};
  var contact = contactParam || {};
  opts = opts || {};

  var firstName = contact.first_name || '';
  var lastName  = contact.last_name || '';
  var practiceName = contact.practice_name || ((firstName + ' ' + lastName).trim()) || '—';

  var startDate = opts.effectiveStartDate ? new Date(opts.effectiveStartDate) : new Date();
  var endDate;
  if (opts.effectiveEndDate) {
    endDate = new Date(opts.effectiveEndDate);
  } else {
    endDate = new Date(startDate.getTime());
    endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);
  }

  var ltv            = _fmtCents(pg.avg_client_ltv_cents);
  var conv           = _fmtRate(pg.conversion_rate);
  var att            = _fmtRate(pg.attendance_rate);
  var valuePerCall   = _fmtCents(pg.value_per_call_cents);
  var investment     = _fmtCents(pg.investment_cents);
  var currentCalls   = (pg.current_monthly_organic_calls != null) ? pg.current_monthly_organic_calls : 0;
  var guaranteeCalls = (pg.guarantee_calls != null) ? pg.guarantee_calls : '—';
  var totalBenchmark = (pg.total_benchmark != null) ? pg.total_benchmark : '—';

  return ''
    + '<div class="pg-doc">'
    + '<div class="pg-meta">'
    +   '<div><span class="pg-meta-label">Client</span><span class="pg-meta-value">' + _esc(practiceName) + '</span></div>'
    +   '<div><span class="pg-meta-label">Effective</span><span class="pg-meta-value">' + _fmtDate(startDate) + ' &ndash; ' + _fmtDate(endDate) + '</span></div>'
    + '</div>'

    + '<h2>Signed Performance Guarantee</h2>'

    + '<p>This Signed Performance Guarantee (the &ldquo;<strong>Guarantee</strong>&rdquo;) is issued under, and governed by, the Client Service Agreement between Moonraker.AI, LLC (&ldquo;<strong>Moonraker</strong>&rdquo;) and ' + _esc(practiceName) + ' (the &ldquo;<strong>Client</strong>&rdquo;). The Guarantee captures the specific benchmark the parties agreed to during the intro call and is the controlling instrument for the guarantee terms described in the CSA.</p>'

    + '<h3>Your Personalized Benchmark</h3>'
    + '<p>The benchmark below is calculated from the Client&rsquo;s practice metrics as reviewed and confirmed with the Client on the intro call.</p>'
    + '<table class="pg-numbers">'
    +   '<tbody>'
    +     '<tr><td>Average Client Lifetime Value</td><td>' + ltv + '</td></tr>'
    +     '<tr><td>Consultation-to-Client Conversion Rate</td><td>' + conv + '</td></tr>'
    +     '<tr><td>Call Attendance Rate</td><td>' + att + '</td></tr>'
    +     '<tr><td>Resulting Value Per Booked Call</td><td><strong>' + valuePerCall + '</strong></td></tr>'
    +     '<tr><td>Current Monthly Organic Calls</td><td>' + currentCalls + '</td></tr>'
    +     '<tr><td>Annual Campaign Investment</td><td>' + investment + '</td></tr>'
    +     '<tr class="pg-row-emphasis"><td>Guarantee Calls Over 12 Months</td><td><strong>' + _esc(String(guaranteeCalls)) + '</strong></td></tr>'
    +     '<tr class="pg-row-emphasis"><td>Total 12-Month Benchmark (Current Run Rate + Guarantee)</td><td><strong>' + _esc(String(totalBenchmark)) + ' organic calls</strong></td></tr>'
    +   '</tbody>'
    + '</table>'

    + '<h3>The Guarantee</h3>'
    + '<p>If Moonraker does not achieve the Total 12-Month Benchmark above within 12 months from the date of this Guarantee, Moonraker will continue delivering the Services set out in the CSA at no additional cost to the Client until the benchmark is achieved.</p>'

    + '<h3>Scope</h3>'
    + '<p>The Guarantee counts only consultations originating from organic channels: Google Search, Google Maps, and AI Search. Consultations from paid advertising, referrals, or other sources do not count toward the benchmark. The Client agrees to grant Moonraker access to relevant systems (website analytics and booking platforms) so performance can be tracked accurately.</p>'

    + '<h3>Effective Dates</h3>'
    + '<p>This Guarantee is effective from <strong>' + _fmtDate(startDate) + '</strong> through <strong>' + _fmtDate(endDate) + '</strong>. If the Client upgrades from a non-commitment plan to an annual plan mid-engagement, a new Signed Performance Guarantee is issued with a fresh 12-month window starting from the new signing date.</p>'

    + '<h3>Relationship to the Client Service Agreement</h3>'
    + '<p>The CSA remains the parent agreement and governs all matters not specifically addressed in this Guarantee (including payment terms, scope of work, cancellation, and dispute resolution). In the event of a conflict between this Guarantee and the CSA, the terms of this Guarantee control only with respect to the performance benchmark described above; all other matters are governed by the CSA.</p>'

    + '</div>';
}

// Build the signature block appended to guarantee_terms_html at sign time.
// Parallels the CSA signature-block pattern used in signAgreement() in the
// onboarding template. `signatureImage` is optional; when present it's
// embedded inline as a data: URL.
function buildSignatureBlockHtml(opts) {
  opts = opts || {};
  var signerName  = opts.signer_name  || '';
  var signerEmail = opts.signer_email || '';
  var signedAtIso = opts.signed_at    || new Date().toISOString();
  var signatureImage = opts.signature_image || '';

  var signedAt = new Date(signedAtIso);
  var dateStr = signedAt.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });

  // Only embed images we produced ourselves — restrict to data: or https:
  // to avoid accidentally stashing hostile markup if inputs ever leak through.
  var safeImg = '';
  if (signatureImage) {
    var s = String(signatureImage).trim();
    if (s.indexOf('data:image/') === 0 || s.indexOf('https://') === 0) {
      safeImg = '<img src="' + _esc(s) + '" style="max-height:60px;display:block;margin-bottom:.75rem;" alt="Client signature">';
    }
  }

  return '<div style="margin-top:2rem;padding-top:1.5rem;border-top:1px solid #ddd;">'
    + '<p style="font-size:.75rem;color:#888;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.5rem;">Signature</p>'
    + safeImg
    + '<p style="margin:0;font-size:.875rem;"><strong>' + _esc(signerName) + '</strong></p>'
    + '<p style="margin:0;font-size:.8125rem;color:#666;">' + _esc(signerEmail) + '</p>'
    + '<p style="margin:0;font-size:.8125rem;color:#666;">Signed: ' + _esc(dateStr) + '</p>'
    + '</div>';
}

module.exports = {
  buildGuaranteeHtml: buildGuaranteeHtml,
  buildSignatureBlockHtml: buildSignatureBlockHtml,
  _esc: _esc,
  _fmtCents: _fmtCents,
  _fmtRate: _fmtRate,
  _fmtDate: _fmtDate
};
