// /shared/image-uploader.js
//
// Pagemaster v2 reusable image uploader widget.
//
// Renders into a container element with a fluid drag-drop zone, "pick from
// library" modal trigger, and "generate" prompt option. Manages all three
// upload paths through a single component:
//
//   1. Direct upload   → /api/upload-image-init → Storage PUT → /api/upload-image-complete
//   2. Stock pick      → /api/process-stock-pick (after picker selection)
//   3. AI generate     → /api/generate-pool-image
//
// All three result in client_image_pool rows with status='pending'. The
// widget polls /api/upload-image-status to flip thumbnails from
// "processing..." to "ready" with the final hosted_url.
//
// Usage:
//   <div id="my-uploader" data-contact-id="..." data-category="practice"></div>
//   <script src="/shared/image-uploader.js" defer></script>
//   <script>
//     window.MRImageUploader.mount('#my-uploader', {
//       contactId: '...',
//       category: 'practice',           // 'practice' | 'logo' | 'headshot' | 'hero' | 'misc'
//       maxFiles: 0,                    // 0 = unlimited
//       allowStock: true,
//       allowGenerate: true,
//       onChange: function(items) { ... },  // Fired after any pool change
//     });
//   </script>
//
// Auth: this widget runs on client-facing onboarding pages (cookie page-token
// scope='onboarding') AND admin pages (admin JWT cookie). The widget itself
// is auth-agnostic; the API routes do the auth check.

(function (root) {
  'use strict';

  // Module-level shared state for poll batching across multiple widgets
  // on the same page.
  var pendingByContact = {};   // contactId -> Set of pool_ids
  var pollTimer = null;
  var POLL_INTERVAL_MS = 2200;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtBytes(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ── API helpers ────────────────────────────────────────────

  function apiPost(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data && data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function apiGet(path) {
    return fetch(path, { credentials: 'same-origin' }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data && data.error || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  // PUT raw bytes to a Supabase Storage signed URL
  function putToSignedUrl(uploadUrl, file) {
    return fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (t) {
          throw new Error('Storage PUT failed: ' + r.status + ' / ' + (t || '').substring(0, 120));
        });
      }
      return true;
    });
  }

  // ── Polling (one batch per contact, regardless of widget count) ─

  function ensurePolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
  }

  function stopPollingIfIdle() {
    var hasPending = Object.keys(pendingByContact).some(function (cid) {
      return pendingByContact[cid] && pendingByContact[cid].size > 0;
    });
    if (!hasPending && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollAll() {
    Object.keys(pendingByContact).forEach(function (contactId) {
      var set = pendingByContact[contactId];
      if (!set || set.size === 0) return;
      var ids = Array.from(set);
      apiGet('/api/upload-image-status?contact_id=' + encodeURIComponent(contactId) + '&pool_ids=' + ids.join(','))
        .then(function (resp) {
          var items = resp.items || [];
          for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.status === 'ready' || item.status === 'failed') {
              set.delete(item.id);
              fireUpdate(contactId, item);
            }
          }
          stopPollingIfIdle();
        })
        .catch(function (err) {
          // Network blip — retry next tick
          console.warn('[image-uploader] poll error:', err.message);
        });
    });
  }

  // Per-contact subscriber list to broadcast status updates to widgets
  var subscribersByContact = {};

  function subscribe(contactId, fn) {
    if (!subscribersByContact[contactId]) subscribersByContact[contactId] = [];
    subscribersByContact[contactId].push(fn);
    return function unsub() {
      var arr = subscribersByContact[contactId] || [];
      var i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    };
  }

  function fireUpdate(contactId, item) {
    var subs = subscribersByContact[contactId] || [];
    for (var i = 0; i < subs.length; i++) {
      try { subs[i](item); } catch (e) { console.warn(e); }
    }
  }

  function trackPending(contactId, poolId) {
    if (!pendingByContact[contactId]) pendingByContact[contactId] = new Set();
    pendingByContact[contactId].add(poolId);
    ensurePolling();
  }

  // ── Uploader instance ────────────────────────────────────

  function mount(target, opts) {
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('mount target not found');

    var contactId = opts.contactId || el.dataset.contactId;
    if (!contactId) throw new Error('contactId required');

    var category = opts.category || el.dataset.category || 'practice';
    var maxFiles = opts.maxFiles == null ? 0 : opts.maxFiles;
    var allowStock = opts.allowStock !== false;
    var allowGenerate = opts.allowGenerate !== false;
    var onChange = opts.onChange || function () {};

    // Local state — items array of { id, status, hosted_url, filename, etc. }
    var items = [];

    el.classList.add('mr-uploader');
    el.innerHTML = renderShell({ category: category, allowStock: allowStock, allowGenerate: allowGenerate });

    var dropZone = el.querySelector('.mr-uploader__drop');
    var fileInput = el.querySelector('.mr-uploader__file-input');
    var grid = el.querySelector('.mr-uploader__grid');
    var stockBtn = el.querySelector('.mr-uploader__stock-btn');
    var genBtn = el.querySelector('.mr-uploader__gen-btn');

    // Initial fetch — load any existing pool images for this category
    refreshExisting();

    // Subscribe to status updates for any pending items
    var unsubscribe = subscribe(contactId, function (statusItem) {
      var idx = items.findIndex(function (it) { return it.id === statusItem.id; });
      if (idx === -1) return;
      items[idx] = Object.assign({}, items[idx], statusItem);
      renderGrid();
      onChange(items);
    });

    // Drag-drop handlers
    ['dragenter', 'dragover'].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropZone.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation();
        dropZone.classList.remove('is-dragover');
      });
    });
    dropZone.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleFiles(files);
    });
    dropZone.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) handleFiles(e.target.files);
      e.target.value = '';
    });

    if (stockBtn) stockBtn.addEventListener('click', openStockPicker);
    if (genBtn) genBtn.addEventListener('click', openGenerator);

    // ── handlers ───────────────────────────────────────────

    function handleFiles(fileList) {
      var arr = Array.from(fileList);
      if (maxFiles > 0) {
        var remaining = Math.max(0, maxFiles - items.length);
        if (remaining === 0) {
          alert('Maximum ' + maxFiles + ' image(s) allowed in this section.');
          return;
        }
        arr = arr.slice(0, remaining);
      }
      arr.forEach(uploadOne);
    }

    function uploadOne(file) {
      // Show optimistic placeholder
      var localId = 'local-' + Math.random().toString(36).slice(2, 8);
      var localUrl = URL.createObjectURL(file);
      var placeholder = {
        id: localId,
        status: 'uploading',
        hosted_url: localUrl,
        filename: file.name,
        bytes: file.size,
        local: true,
      };
      items.push(placeholder);
      renderGrid();

      apiPost('/api/upload-image-init', {
        contact_id: contactId,
        category: category,
        filename: file.name,
        mime_type: file.type || 'image/jpeg',
        bytes: file.size,
      }).then(function (initResp) {
        // Replace local id with server pool_id
        var idx = items.findIndex(function (it) { return it.id === localId; });
        if (idx !== -1) {
          items[idx] = Object.assign({}, items[idx], { id: initResp.pool_id, status: 'uploading' });
          renderGrid();
        }
        return putToSignedUrl(initResp.upload_url, file)
          .then(function () {
            return apiPost('/api/upload-image-complete', {
              pool_id: initResp.pool_id,
              contact_id: contactId,
            });
          })
          .then(function () {
            // Mark local as 'processing' and start polling
            var i2 = items.findIndex(function (it) { return it.id === initResp.pool_id; });
            if (i2 !== -1) {
              items[i2] = Object.assign({}, items[i2], { status: 'pending', local: false });
              renderGrid();
            }
            trackPending(contactId, initResp.pool_id);
          });
      }).catch(function (err) {
        console.error('[image-uploader] upload error:', err);
        var idx = items.findIndex(function (it) { return it.id === localId; });
        if (idx !== -1) {
          items[idx] = Object.assign({}, items[idx], { status: 'failed', error: err.message });
          renderGrid();
        }
      });
    }

    function openStockPicker() {
      var query = window.prompt('Search our library (e.g. "office", "nature", "hands"):');
      if (!query) return;
      apiPost('/api/search-stock-images', { query: query, contact_id: contactId, limit: 30 })
        .then(function (resp) {
          var stock = resp.stock || [];
          if (!stock.length) {
            alert('No matches found. Try different keywords.');
            return;
          }
          showStockModal(stock, function (picked) {
            if (!picked.length) return;
            var loadingItems = picked.map(function (s) {
              return {
                id: 'stock-' + s.id,
                status: 'uploading',
                hosted_url: s.hosted_url,
                filename: 'stock-' + s.id,
                local: true,
              };
            });
            items = items.concat(loadingItems);
            renderGrid();
            apiPost('/api/process-stock-pick', {
              contact_id: contactId,
              category: category,
              stock_image_ids: picked.map(function (s) { return s.id; }),
            }).then(function (pickResp) {
              (pickResp.items || []).forEach(function (r, i) {
                var localId = 'stock-' + picked[i].id;
                var idx = items.findIndex(function (it) { return it.id === localId; });
                if (idx === -1) return;
                if (r.ok) {
                  items[idx] = Object.assign({}, items[idx], {
                    id: r.pool_id,
                    status: r.existing ? 'ready' : 'pending',
                    local: false,
                  });
                  if (!r.existing) trackPending(contactId, r.pool_id);
                } else {
                  items[idx] = Object.assign({}, items[idx], {
                    status: 'failed',
                    error: r.error,
                  });
                }
              });
              renderGrid();
              onChange(items);
            }).catch(function (err) {
              alert('Could not add stock images: ' + err.message);
            });
          });
        }).catch(function (err) { alert('Search failed: ' + err.message); });
    }

    function openGenerator() {
      var prompt = window.prompt('Describe the image you want (e.g. "warm therapy office with plants and natural light"):');
      if (!prompt) return;
      var localId = 'gen-' + Math.random().toString(36).slice(2, 8);
      items.push({
        id: localId,
        status: 'uploading',
        hosted_url: '',
        filename: 'generating...',
        local: true,
        generating: true,
      });
      renderGrid();
      apiPost('/api/generate-pool-image', {
        contact_id: contactId,
        category: category,
        prompt: prompt,
      }).then(function (resp) {
        var idx = items.findIndex(function (it) { return it.id === localId; });
        if (idx !== -1) {
          items[idx] = Object.assign({}, items[idx], {
            id: resp.pool_id,
            status: 'pending',
            local: false,
          });
          renderGrid();
        }
        trackPending(contactId, resp.pool_id);
      }).catch(function (err) {
        var idx = items.findIndex(function (it) { return it.id === localId; });
        if (idx !== -1) {
          items[idx] = Object.assign({}, items[idx], { status: 'failed', error: err.message });
          renderGrid();
        }
      });
    }

    function refreshExisting() {
      apiGet('/api/list-pool-images?contact_id=' + encodeURIComponent(contactId) + '&category=' + encodeURIComponent(category))
        .then(function (resp) {
          var existing = (resp.items || []).filter(function (it) {
            // For headshot category, optionally further filter by bio_material_id
            if (opts.bioMaterialId && it.bio_material_id !== opts.bioMaterialId) return false;
            return true;
          });
          // Merge with any session-added items, but server is source of truth
          // for ids that match
          var sessionIds = new Set(items.map(function (it) { return it.id; }));
          existing.forEach(function (it) {
            if (!sessionIds.has(it.id)) items.push(it);
          });
          // Track any still-pending items for polling
          existing.forEach(function (it) {
            if (it.status === 'pending') trackPending(contactId, it.id);
          });
          renderGrid();
          onChange(items);
        })
        .catch(function (err) {
          console.warn('[image-uploader] refresh failed:', err.message);
        });
    }

    function renderGrid() {
      grid.innerHTML = items.map(function (it) {
        var statusBadge =
          it.status === 'failed' ? '<span class="mr-uploader__badge mr-uploader__badge--failed">Failed</span>' :
          it.status === 'pending' ? '<span class="mr-uploader__badge mr-uploader__badge--pending">Processing…</span>' :
          it.status === 'uploading' ? '<span class="mr-uploader__badge mr-uploader__badge--pending">Uploading…</span>' :
          '';
        var imgHtml = it.hosted_url
          ? '<img src="' + escapeHtml(it.hosted_url) + '" alt="' + escapeHtml(it.alt_text || it.filename || '') + '">'
          : '<div class="mr-uploader__no-img">' + (it.generating ? '✨' : '⏳') + '</div>';
        var bytesLabel = it.bytes ? '<span class="mr-uploader__bytes">' + escapeHtml(fmtBytes(it.bytes)) + '</span>' : '';
        return [
          '<div class="mr-uploader__tile' + (it.status === 'failed' ? ' is-failed' : '') + (it.status === 'pending' || it.status === 'uploading' ? ' is-loading' : '') + '" data-id="' + escapeHtml(it.id) + '">',
          imgHtml,
          statusBadge,
          '<button class="mr-uploader__remove" type="button" aria-label="Remove" data-id="' + escapeHtml(it.id) + '">×</button>',
          bytesLabel,
          '</div>',
        ].join('');
      }).join('');

      // Bind remove buttons
      grid.querySelectorAll('.mr-uploader__remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var id = btn.dataset.id;
          // Soft remove from UI; archive on server handled separately by admin tools
          var idx = items.findIndex(function (it) { return it.id === id; });
          if (idx !== -1) {
            items.splice(idx, 1);
            renderGrid();
            onChange(items);
            // Mark archived on server (best-effort, fire-and-forget)
            if (!String(id).startsWith('local-') && !String(id).startsWith('stock-') && !String(id).startsWith('gen-')) {
              apiPost('/api/archive-pool-image', { contact_id: contactId, pool_id: id })
                .catch(function () { /* non-critical */ });
            }
          }
        });
      });

      onChange(items);
    }

    return {
      destroy: function () {
        unsubscribe();
        el.innerHTML = '';
      },
      getItems: function () { return items.slice(); },
    };
  }

  function renderShell(opts) {
    var hint = {
      practice: 'Office, lobby, exterior, neighborhood',
      logo: 'Your practice logo (PNG with transparent background works best)',
      headshot: 'Professional headshot for the bio page',
      hero: 'Hero / banner image',
      misc: 'Any image',
    }[opts.category] || 'Photos';

    var sideButtons = [];
    if (opts.allowStock) {
      sideButtons.push('<button type="button" class="mr-uploader__side-btn mr-uploader__stock-btn">Pick from library</button>');
    }
    if (opts.allowGenerate) {
      sideButtons.push('<button type="button" class="mr-uploader__side-btn mr-uploader__gen-btn">Generate ✨</button>');
    }

    return [
      '<div class="mr-uploader__zone">',
      '  <div class="mr-uploader__drop">',
      '    <input type="file" class="mr-uploader__file-input" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple style="display:none;">',
      '    <div class="mr-uploader__drop-icon">📷</div>',
      '    <div class="mr-uploader__drop-title">Drop photos here or tap to choose</div>',
      '    <div class="mr-uploader__drop-hint">' + escapeHtml(hint) + '</div>',
      '  </div>',
      sideButtons.length ? '<div class="mr-uploader__side">' + sideButtons.join('') + '</div>' : '',
      '</div>',
      '<div class="mr-uploader__grid"></div>',
    ].join('');
  }

  function showStockModal(stock, onPick) {
    var picked = new Set();
    var modal = document.createElement('div');
    modal.className = 'mr-uploader-modal';
    modal.innerHTML = [
      '<div class="mr-uploader-modal__backdrop"></div>',
      '<div class="mr-uploader-modal__panel">',
      '  <div class="mr-uploader-modal__header">',
      '    <h3>Pick from library</h3>',
      '    <button type="button" class="mr-uploader-modal__close" aria-label="Close">×</button>',
      '  </div>',
      '  <div class="mr-uploader-modal__grid">',
      stock.map(function (s) {
        return [
          '<div class="mr-uploader-modal__tile" data-id="' + s.id + '">',
          '  <img src="' + escapeHtml(s.hosted_url) + '" alt="' + escapeHtml(s.rich_description || '') + '" loading="lazy">',
          '  <div class="mr-uploader-modal__check">✓</div>',
          '</div>',
        ].join('');
      }).join(''),
      '  </div>',
      '  <div class="mr-uploader-modal__footer">',
      '    <button type="button" class="mr-uploader-modal__cancel">Cancel</button>',
      '    <button type="button" class="mr-uploader-modal__confirm" disabled>Add (0)</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(modal);

    var grid = modal.querySelector('.mr-uploader-modal__grid');
    var confirmBtn = modal.querySelector('.mr-uploader-modal__confirm');
    var close = function () { modal.remove(); };

    grid.querySelectorAll('.mr-uploader-modal__tile').forEach(function (tile) {
      tile.addEventListener('click', function () {
        var id = parseInt(tile.dataset.id, 10);
        if (picked.has(id)) {
          picked.delete(id);
          tile.classList.remove('is-picked');
        } else {
          picked.add(id);
          tile.classList.add('is-picked');
        }
        confirmBtn.disabled = picked.size === 0;
        confirmBtn.textContent = 'Add (' + picked.size + ')';
      });
    });

    modal.querySelector('.mr-uploader-modal__close').addEventListener('click', close);
    modal.querySelector('.mr-uploader-modal__cancel').addEventListener('click', close);
    modal.querySelector('.mr-uploader-modal__backdrop').addEventListener('click', close);
    confirmBtn.addEventListener('click', function () {
      var pickedItems = stock.filter(function (s) { return picked.has(s.id); });
      close();
      onPick(pickedItems);
    });
  }

  // Inject the widget styles once (idempotent)
  function injectStyles() {
    if (document.getElementById('mr-uploader-styles')) return;
    var style = document.createElement('style');
    style.id = 'mr-uploader-styles';
    style.textContent = MR_UPLOADER_CSS;
    document.head.appendChild(style);
  }

  var MR_UPLOADER_CSS = [
    '.mr-uploader { display: flex; flex-direction: column; gap: 1rem; }',
    '.mr-uploader__zone { display: grid; grid-template-columns: 1fr auto; gap: 0.75rem; align-items: stretch; }',
    '@media (max-width: 600px) { .mr-uploader__zone { grid-template-columns: 1fr; } }',
    '.mr-uploader__drop { border: 2px dashed rgba(0,0,0,0.18); border-radius: 12px; padding: 2rem 1.5rem; text-align: center; cursor: pointer; transition: border-color 0.2s ease, background 0.2s ease; background: rgba(0,0,0,0.015); }',
    '.mr-uploader__drop:hover, .mr-uploader__drop.is-dragover { border-color: var(--color-accent, #00d47e); background: rgba(0,212,126,0.06); }',
    '.mr-uploader__drop-icon { font-size: 2rem; margin-bottom: 0.5rem; opacity: 0.7; }',
    '.mr-uploader__drop-title { font-weight: 600; margin-bottom: 0.25rem; }',
    '.mr-uploader__drop-hint { font-size: 0.875rem; opacity: 0.7; }',
    '.mr-uploader__side { display: flex; flex-direction: column; gap: 0.5rem; justify-content: center; }',
    '.mr-uploader__side-btn { padding: 0.625rem 1rem; border-radius: 8px; border: 1px solid rgba(0,0,0,0.12); background: #fff; cursor: pointer; font-weight: 500; font-size: 0.875rem; transition: background 0.18s ease, border-color 0.18s ease; }',
    '.mr-uploader__side-btn:hover { background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.2); }',
    '.mr-uploader__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.75rem; }',
    '.mr-uploader__tile { position: relative; aspect-ratio: 1 / 1; border-radius: 10px; overflow: hidden; background: rgba(0,0,0,0.04); border: 1px solid rgba(0,0,0,0.06); }',
    '.mr-uploader__tile img { width: 100%; height: 100%; object-fit: cover; display: block; }',
    '.mr-uploader__tile.is-loading img { opacity: 0.6; filter: blur(2px); }',
    '.mr-uploader__tile.is-failed { border-color: rgba(220, 38, 38, 0.3); }',
    '.mr-uploader__no-img { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; font-size: 2rem; opacity: 0.5; }',
    '.mr-uploader__badge { position: absolute; bottom: 0.5rem; left: 0.5rem; right: 0.5rem; text-align: center; padding: 0.25rem 0.5rem; border-radius: 6px; font-size: 0.7rem; font-weight: 600; background: rgba(0,0,0,0.7); color: #fff; }',
    '.mr-uploader__badge--failed { background: rgba(220, 38, 38, 0.9); }',
    '.mr-uploader__remove { position: absolute; top: 0.375rem; right: 0.375rem; width: 24px; height: 24px; border-radius: 50%; border: 0; background: rgba(0,0,0,0.6); color: #fff; cursor: pointer; font-size: 1rem; line-height: 1; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.18s ease; }',
    '.mr-uploader__tile:hover .mr-uploader__remove { opacity: 1; }',
    '.mr-uploader__bytes { position: absolute; top: 0.5rem; left: 0.5rem; font-size: 0.7rem; color: #fff; background: rgba(0,0,0,0.55); padding: 0.125rem 0.375rem; border-radius: 4px; }',
    /* Modal */
    '.mr-uploader-modal { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 1rem; }',
    '.mr-uploader-modal__backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.55); }',
    '.mr-uploader-modal__panel { position: relative; background: #fff; border-radius: 14px; max-width: 920px; width: 100%; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }',
    '.mr-uploader-modal__header { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.25rem; border-bottom: 1px solid rgba(0,0,0,0.08); }',
    '.mr-uploader-modal__header h3 { margin: 0; font-size: 1.125rem; }',
    '.mr-uploader-modal__close { background: none; border: 0; font-size: 1.5rem; cursor: pointer; opacity: 0.6; padding: 0.25rem 0.5rem; }',
    '.mr-uploader-modal__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.625rem; padding: 1rem 1.25rem; overflow-y: auto; flex: 1; }',
    '.mr-uploader-modal__tile { position: relative; aspect-ratio: 1 / 1; border-radius: 8px; overflow: hidden; cursor: pointer; border: 2px solid transparent; transition: border-color 0.18s ease, transform 0.18s ease; }',
    '.mr-uploader-modal__tile img { width: 100%; height: 100%; object-fit: cover; display: block; }',
    '.mr-uploader-modal__tile:hover { transform: translateY(-2px); }',
    '.mr-uploader-modal__tile.is-picked { border-color: var(--color-accent, #00d47e); }',
    '.mr-uploader-modal__check { position: absolute; top: 0.375rem; right: 0.375rem; width: 24px; height: 24px; border-radius: 50%; background: var(--color-accent, #00d47e); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 0.875rem; font-weight: 700; opacity: 0; transition: opacity 0.18s ease; }',
    '.mr-uploader-modal__tile.is-picked .mr-uploader-modal__check { opacity: 1; }',
    '.mr-uploader-modal__footer { display: flex; justify-content: flex-end; gap: 0.5rem; padding: 1rem 1.25rem; border-top: 1px solid rgba(0,0,0,0.08); }',
    '.mr-uploader-modal__cancel, .mr-uploader-modal__confirm { padding: 0.625rem 1.25rem; border-radius: 8px; border: 0; cursor: pointer; font-weight: 600; }',
    '.mr-uploader-modal__cancel { background: rgba(0,0,0,0.06); }',
    '.mr-uploader-modal__confirm { background: var(--color-accent, #00d47e); color: #fff; }',
    '.mr-uploader-modal__confirm:disabled { opacity: 0.4; cursor: not-allowed; }',
  ].join('\n');

  injectStyles();

  root.MRImageUploader = {
    mount: mount,
    _injectStyles: injectStyles,
  };
})(window);
