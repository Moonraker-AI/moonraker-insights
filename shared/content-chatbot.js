// /shared/content-chatbot.js
// Self-contained chatbot widget for content preview pages.
// Floating button (bottom-right), streaming Sonnet 4.6 chat.
// Handles <content_update> tags: extracts new HTML, updates preview iframe, saves to Supabase.
// Include via <script src="/shared/content-chatbot.js"></script>
// Page must set window.__CONTENT_PAGE_ID and window.__CLIENT_SLUG before loading.

(function() {
  'use strict';

  var contentPageId = window.__CONTENT_PAGE_ID || '';
  var clientSlug = window.__CLIENT_SLUG || '';

  // Filter out <content_update> tags during typewriter display
  function filterDisplay(text) {
    text = text.replace(/<content_update>[\s\S]*?<\/content_update>/g, '');
    text = text.replace(/<content_update>[\s\S]*/g, '');
    return text;
  }

  // Apply content update: update iframe, show badge, save to Supabase
  function applyContentUpdate(newHtml, aiDiv, messages) {
    // Update the iframe
    var iframe = document.getElementById('contentPreviewFrame');
    if (iframe) {
      iframe.srcdoc = newHtml;
    }

    // Show update badge
    var badge = document.createElement('div');
    badge.className = 'mcc-update-badge';
    badge.textContent = 'Page updated';
    aiDiv.appendChild(badge);

    // Save to Supabase via action API
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update_record',
        table: 'content_pages',
        id: contentPageId,
        data: { generated_html: newHtml }
      })
    }).then(function(r) { return r.json(); }).then(function(res) {
      if (res.success) {
        // Create version record
        fetch('/api/action', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'create_record',
            table: 'content_page_versions',
            data: {
              content_page_id: contentPageId,
              html: newHtml,
              change_summary: messages[messages.length - 2] ? messages[messages.length - 2].content : 'Client edit',
              changed_by: 'client'
            }
          })
        }).catch(function(e) { console.error('Version save failed:', e); });
      }
    }).catch(function() { /* silent */ });

    // Also save chat messages
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create_record',
        table: 'content_chat_messages',
        data: { content_page_id: contentPageId, role: 'user', content: messages[messages.length - 2] ? messages[messages.length - 2].content : '' }
      })
    }).catch(function(e) { console.error('Chat message save failed:', e); });
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'create_record',
        table: 'content_chat_messages',
        data: { content_page_id: contentPageId, role: 'assistant', content: messages[messages.length - 1] ? messages[messages.length - 1].content : '' }
      })
    }).catch(function(e) { console.error('Chat message save failed:', e); });
  }

  function init() {
    var bot = window.MoonrakerChatbot({
      prefix: 'mcc',
      apiUrl: '/api/content-chat',
      tooltipKey: 'moonraker-content-tooltip-dismissed',
      btnTitle: 'Review your page',
      title: 'Content Review',
      subtitle: 'Ask me to update anything on this page',
      tooltipIcon: '',
      tooltipHtml: "<strong>Review your new page!</strong><br>Ask me to make any changes to the content, and you'll see them update in real time.",
      welcomeIcon: '&#128196;',
      welcomeTitle: 'Your page is ready for review',
      welcomeText: "Take a look at the content below and let me know if you'd like any changes.",
      chipStyle: 'vertical',
      chipClass: 'mcc-suggestion',
      chipAttr: 'data-msg',
      chips: [
        { label: 'Walk me through this page', question: 'Can you walk me through what\'s on this page?' },
        { label: 'Update insurance info', question: 'I\'d like to update my insurance information.' },
        { label: 'Make it warmer', question: 'Can you adjust the tone to feel warmer and more personal?' }
      ],
      placeholder: 'Ask a question or request a change...',
      headerIcon: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#00D47E" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',
      filterDisplay: filterDisplay,
      buildContext: function() {
        return { content_page_id: contentPageId, slug: clientSlug };
      },
      onStreamComplete: function(fullText, aiDiv, helpers) {
        // Store assistant message (clean of content_update tags)
        var cleanText = fullText.replace(/<content_update>[\s\S]*?<\/content_update>/g, '').trim();
        helpers.messages.push({ role: 'assistant', content: cleanText });

        // Check for content update
        var updateMatch = fullText.match(/<content_update>([\s\S]*?)<\/content_update>/);
        if (updateMatch && updateMatch[1]) {
          var newHtml = updateMatch[1].trim();
          applyContentUpdate(newHtml, aiDiv, helpers.messages);
        }
      }
    });

    // Inject content-chatbot-specific CSS (update badge, user bubble color override)
    var extraStyle = document.createElement('style');
    extraStyle.textContent = `
      .mcc-update-badge {
        display: inline-block; font-size: .68rem; font-weight: 600; padding: .15rem .45rem;
        border-radius: 4px; background: rgba(0,212,126,.12); color: #00b86c;
        margin-top: .35rem;
      }
      .mcc-msg-user .mcc-msg-bubble { color: #fff; border-bottom-right-radius: 4px; border-radius: 12px 12px 4px 12px; }
      .mcc-msg-ai .mcc-msg-bubble { background: var(--color-bg, #F0F4F8); border-bottom-left-radius: 4px; }
      .mcc-send { border-radius: 50%; }
      .mcc-send svg { fill: #fff; }
      .mcc-messages { padding: .75rem; gap: .5rem; }
      .mcc-msg-bubble { max-width: 85%; line-height: 1.55; }
      .mcc-msg-bubble p { margin: .4rem 0; }
      .mcc-msg-bubble p:first-child { margin-top: 0; }
      .mcc-msg { max-width: 100%; }
      .mcc-msg-user { justify-content: flex-end; }
      .mcc-msg-ai { justify-content: flex-start; }
      .mcc-input-area { padding: .65rem; display: flex; gap: .5rem; }
      .mcc-input { background: var(--color-bg, #F0F4F8); }
    `;
    document.head.appendChild(extraStyle);
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
