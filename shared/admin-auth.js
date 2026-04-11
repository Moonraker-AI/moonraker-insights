// shared/admin-auth.js
// Include on all /admin/* pages (except login).
// Checks for a valid Supabase Auth session, redirects to login if missing.
// Auto-injects Authorization header into all /api/* fetch calls.
// Exposes window.adminAuth for use by page scripts.
//
// Usage in admin pages:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
//   <script src="/shared/admin-auth.js"></script>
//   <script>
//     adminAuth.ready(function(session, user) {
//       // Auth confirmed. All fetch('/api/...') calls now auto-include auth.
//       loadPageData();
//     });
//   </script>

(function() {
  var SB_URL = 'https://ofmmwcjhdrhvxxkhcuww.supabase.co';
  var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbW13Y2poZHJodnh4a2hjdXd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzMjM1NTcsImV4cCI6MjA4OTg5OTU1N30.zMMHW0Fk9ixWjORngyxJTIoPOfx7GFsD4wBV4Foqqms';

  var client = window.supabase.createClient(SB_URL, SB_ANON);
  var _session = null;
  var _user = null;
  var _readyCallbacks = [];
  var _resolved = false;

  function goLogin() {
    window.location.href = '/admin/login';
  }

  // ── Fetch interceptor ──────────────────────────────────────────
  // Monkey-patches window.fetch to auto-inject the Authorization header
  // on any request to /api/* (same-origin). Existing headers are preserved.
  var _origFetch = window.fetch;

  window.fetch = function(input, init) {
    if (_session) {
      var url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
      // Only intercept same-origin /api/ calls (not external URLs)
      if (url.indexOf('/api/') === 0) {
        init = init || {};
        init.headers = init.headers || {};
        // Don't override if already set (e.g. for webhook callbacks)
        if (!init.headers['Authorization'] && !init.headers['authorization']) {
          init.headers['Authorization'] = 'Bearer ' + _session.access_token;
        }
      }
    }
    return _origFetch.call(window, input, init);
  };

  // ── Init ───────────────────────────────────────────────────────

  async function init() {
    try {
      var result = await client.auth.getSession();
      if (!result.data.session) { goLogin(); return; }

      _session = result.data.session;

      // Verify admin profile
      var resp = await _origFetch(SB_URL + '/rest/v1/admin_profiles?id=eq.' + _session.user.id + '&select=id,email,display_name,role&limit=1', {
        headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + _session.access_token }
      });
      var profiles = await resp.json();

      if (!Array.isArray(profiles) || profiles.length === 0) {
        await client.auth.signOut();
        goLogin();
        return;
      }

      _user = {
        id: profiles[0].id,
        email: profiles[0].email,
        name: profiles[0].display_name,
        role: profiles[0].role
      };

      _resolved = true;
      for (var i = 0; i < _readyCallbacks.length; i++) {
        try { _readyCallbacks[i](_session, _user); } catch (e) { console.error('[admin-auth] ready callback error:', e); }
      }
      _readyCallbacks = [];

    } catch (e) {
      console.error('[admin-auth] Init failed:', e);
      goLogin();
    }
  }

  // Listen for token refresh and sign-out
  client.auth.onAuthStateChange(function(event, session) {
    if (event === 'SIGNED_OUT') {
      _session = null;
      goLogin();
    } else if (event === 'TOKEN_REFRESHED' && session) {
      _session = session;
    }
  });

  // ── Public API ─────────────────────────────────────────────────

  window.adminAuth = {
    // Register a callback for when auth is ready. If already ready, fires immediately.
    ready: function(cb) {
      if (_resolved) { cb(_session, _user); }
      else { _readyCallbacks.push(cb); }
    },

    // Get current access token
    token: function() { return _session ? _session.access_token : null; },

    // Get current user info { id, email, role, name }
    user: function() { return _user; },

    // The Supabase client instance
    supabase: client,

    // Sign out and redirect to login
    signOut: async function() {
      await client.auth.signOut();
      _session = null;
      goLogin();
    },

    // Constants
    SB_URL: SB_URL,
    SB_ANON: SB_ANON
  };

  // Start auth check immediately
  init();
})();
