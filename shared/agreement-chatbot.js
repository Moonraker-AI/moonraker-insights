// /shared/agreement-chatbot.js
// Self-contained chatbot widget for the Client Service Agreement page.
// Floating button (bottom-right), dismissible tooltip, streaming Sonnet 4.6 chat.
// Include via <script src="/shared/agreement-chatbot.js"></script>

(function() {
  'use strict';

  var pageContent = '';

  function extractPageContent() {
    var main = document.querySelector('.container') || document.body;
    var text = main.innerText || main.textContent || '';
    text = text.replace(/\s+/g, ' ').trim();
    return text.substring(0, 10000);
  }

  function init() {
    window.MoonrakerChatbot({
      prefix: 'mpc',
      apiUrl: '/api/agreement-chat',
      tooltipKey: 'moonraker-agreement-tooltip-dismissed',
      btnTitle: 'Chat about the agreement',
      title: 'Agreement Assistant',
      subtitle: 'Powered by Claude Sonnet 4.6',
      tooltipIcon: '&#128172;',
      tooltipHtml: "<strong>Questions about the agreement?</strong><br>I can explain any section, clarify terms, walk you through what's included, or answer anything else. Just ask!",
      welcomeIcon: '&#128075;',
      welcomeTitle: "Hi! I'm your Agreement Assistant",
      welcomeText: "I can answer questions about the Client Service Agreement, what's included in the CORE campaign, pricing, cancellation, or anything else you're curious about.",
      chips: [
        { label: "What's included", question: 'What services are included in the campaign?' },
        { label: 'Guarantee', question: 'What is the performance guarantee?' },
        { label: 'Payment', question: 'How does payment work for my plan?' },
        { label: 'Cancellation', question: 'Can I cancel if I need to?' },
        { label: 'Ownership', question: 'Who owns the work you create?' }
      ],
      placeholder: 'Ask about the agreement...',
      headerIcon: '<img src="/assets/logo.png" alt="M">',
      onOpen: function() {
        if (!pageContent) pageContent = extractPageContent();
      },
      buildContext: function() {
        if (!pageContent) pageContent = extractPageContent();
        return { page_content: pageContent };
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
