// /shared/campaign-summary-chatbot.js
// Self-contained chatbot widget for campaign-summary pages.
// Floating button (bottom-right), dismissible tooltip, streaming Sonnet 4.6 chat.
// Include via <script src="/shared/campaign-summary-chatbot.js"></script>
//
// Expects window.__CAMPAIGN_SUMMARY_CONTEXT to be populated by the page
// (the campaign-summary template stashes it in render()).
//
// Shape: { slug: string, data: <full /api/campaign-summary response> }

(function() {
  'use strict';

  function init() {
    window.MoonrakerChatbot({
      prefix: 'mrc',
      apiUrl: '/api/campaign-summary-chat',
      tooltipKey: 'moonraker-campaign-summary-tooltip-dismissed',
      btnTitle: 'Ask about your campaign summary',
      btnSvg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>',
      title: 'Campaign Summary Assistant',
      subtitle: 'Powered by Claude Sonnet 4.6',
      tooltipIcon: '&#128200;',
      tooltipHtml: '<strong>Questions about your campaign summary?</strong><br>I can walk you through year-over-year results, the performance guarantee, what we delivered, and what is ahead.',
      welcomeIcon: '&#128200;',
      welcomeTitle: 'Hi! Let me walk you through your campaign.',
      welcomeText: 'Ask about your results, what we shipped, whether we hit the performance guarantee, or what the next period looks like.',
      chips: [
        { label: 'Year-over-year growth', question: 'Walk me through my year-over-year growth in appointments and revenue.' },
        { label: 'Performance guarantee', question: 'Did you hit the performance guarantee?' },
        { label: 'What you delivered', question: 'What did you deliver over this engagement?' },
        { label: 'Plan ahead', question: "What's the plan for the next period?" }
      ],
      placeholder: 'Ask about your campaign...',
      headerIcon: '<img src="/assets/logo.png" alt="Moonraker">',
      buildContext: function() {
        // Read fresh each call so late render / theme toggle can't serve stale data
        return window.__CAMPAIGN_SUMMARY_CONTEXT || {};
      }
    });
  }

  if (window.MoonrakerChatbot) {
    init();
  } else {
    var s = document.createElement('script');
    s.src = '/shared/chatbot-base.js';
    s.onload = init;
    document.head.appendChild(s);
  }
})();
