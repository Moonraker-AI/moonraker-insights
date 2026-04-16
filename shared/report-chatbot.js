// /shared/report-chatbot.js
// Self-contained chatbot widget for report pages.
// Floating button (bottom-right), dismissible tooltip, streaming Sonnet 4.6 chat.
// Include via <script src="/shared/report-chatbot.js"></script>
//
// Expects window.__REPORT_CHAT_CONTEXT to be set before this script loads:
//   { snapshot: {...}, highlights: [...], practice_name: "...", campaign_month: 2 }

(function() {
  'use strict';

  function init() {
    var chatContext = window.__REPORT_CHAT_CONTEXT || {};

    window.MoonrakerChatbot({
      prefix: 'mrc',
      apiUrl: '/api/report-chat',
      tooltipKey: 'moonraker-report-tooltip-dismissed',
      btnTitle: 'Ask about your report',
      btnSvg: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>',
      title: 'Report Assistant',
      subtitle: 'Powered by Claude Sonnet 4.6',
      tooltipIcon: '&#128202;',
      tooltipHtml: '<strong>Have questions about your report?</strong><br>I can explain any metric, walk you through what the data means for your practice, and answer questions about your campaign.',
      welcomeIcon: '&#128202;',
      welcomeTitle: 'Hi! I can help explain your report.',
      welcomeText: 'Ask me anything about your campaign performance, what the metrics mean, or what we are working on next.',
      chips: [
        { label: 'Website performance', question: 'How is my website performing this month?' },
        { label: 'AI visibility', question: 'Which AI platforms recommend my practice?' },
        { label: 'Maps ranking', question: 'How visible am I on Google Maps?' },
        { label: 'Current work', question: 'What are you working on to improve my visibility?' }
      ],
      placeholder: 'Ask about your report...',
      headerIcon: '<img src="/assets/logo.png" alt="Moonraker">',
      buildContext: function() {
        return chatContext;
      }
    });
  }

  // Auto-load base module if not already present
  if (window.MoonrakerChatbot) {
    init();
  } else {
    var s = document.createElement('script');
    s.src = '/shared/chatbot-base.js';
    s.onload = init;
    document.head.appendChild(s);
  }
})();
