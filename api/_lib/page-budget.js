// /api/_lib/page-budget.js
// Computes per-type page budgets for a contact:
//   total = (plan default for type) + (sum of paid addon_orders.qty for type's tier_keys)
//   used  = count of build/update site_map_pages of that type
//   remaining = total - used
//
// Returns a per-type breakdown plus an overall summary. Pure derivation —
// no stored counter on contact, no drift risk.
//
// Usage:
//   var budget = require('./_lib/page-budget');
//   var snapshot = await budget.computeForContact(contactId);
//   // snapshot = { types: { service: { total, used, remaining, ... }, ... }, overall: {...} }
//
// Performance: single pass over a few small queries. Safe to call per request.

var sb = require('./supabase');
var pageTypes = require('./page-types');

// Map site_map_pages.category to page_type. site_map_pages predates the
// taxonomy in page-types.js — these are the legacy categories the site
// map configurator uses.
var SITEMAP_CATEGORY_TO_TYPE = {
  homepage: 'homepage',
  service: 'service',
  services: 'service',
  service_page: 'service',
  location: 'location',
  locations: 'location',
  location_page: 'location',
  bio: 'bio',
  bio_page: 'bio',
  about: 'about_us',
  about_us: 'about_us',
  faq: 'faq_general',
  faq_general: 'faq_general',
  contact: 'contact',
  privacy: 'privacy',
  tos: 'tos',
  terms: 'tos',
  custom: 'custom',
  resource: 'custom',
  resources: 'custom',
};

// site_map_pages.status values that consume budget.
// 'build' = new page to construct. 'update_as_target' = rebuild existing.
// Anything else (existing_keep, remove, discovered, new, etc.) is free.
var BUDGET_CONSUMING_STATUSES = ['build', 'update_as_target'];

function categoryToType(category) {
  if (!category) return null;
  return SITEMAP_CATEGORY_TO_TYPE[String(category).toLowerCase()] || null;
}

// Compute a snapshot of all page budgets for a contact.
async function computeForContact(contactId) {
  if (!contactId) throw new Error('contactId required');
  if (!sb.isConfigured()) throw new Error('Supabase not configured');

  // Pull the inputs in parallel
  var encId = encodeURIComponent(contactId);
  var results = await Promise.all([
    // P1 tracked keywords count (for service-page default)
    sb.query('tracked_keywords?contact_id=eq.' + encId + '&active=eq.true&priority=eq.P1&select=id'),
    // Paid addon orders by tier_key
    sb.query('addon_orders?contact_id=eq.' + encId + '&status=eq.paid&select=id,product_key,qty,metadata'),
    // Active site_map (latest non-launched, or any if launched)
    sb.query('site_maps?contact_id=eq.' + encId + '&order=created_at.desc&limit=1&select=id'),
    // contacts row (for context like team_size, num_locations)
    sb.query('contacts?id=eq.' + encId + '&select=team_size,num_locations,plan_tier&limit=1'),
  ]);

  var p1Count = (results[0] || []).length;
  var addonOrders = results[1] || [];
  var siteMap = results[2] && results[2][0];
  var contact = results[3] && results[3][0];

  // Pull site_map_pages in a second query (depends on site_map id)
  var smPages = [];
  if (siteMap && siteMap.id) {
    smPages = await sb.query(
      'site_map_pages?site_map_id=eq.' + encodeURIComponent(siteMap.id) +
      '&select=id,category,status'
    ) || [];
  }

  // Build a tier_key -> qty map from addon_orders.
  // addon_orders rows can store the tier_key in metadata (canonical) or
  // — for older rows — derive it from product_key + payment hints.
  // For now we accept either:
  //   metadata.tier_key string match
  //   product_key matches an addon tier_key directly
  var addonByTierKey = {};
  for (var i = 0; i < addonOrders.length; i++) {
    var a = addonOrders[i];
    var qty = (typeof a.qty === 'number' && a.qty > 0) ? a.qty : 1;
    var tierKey = (a.metadata && a.metadata.tier_key) || a.product_key || null;
    if (tierKey) {
      addonByTierKey[tierKey] = (addonByTierKey[tierKey] || 0) + qty;
    }
  }

  // Count site-map consumption per page type
  var usedByType = {};
  for (var j = 0; j < smPages.length; j++) {
    var smp = smPages[j];
    if (BUDGET_CONSUMING_STATUSES.indexOf(smp.status) === -1) continue;
    var t = categoryToType(smp.category);
    if (!t) continue;
    if (!pageTypes.get(t)) continue;
    if (!pageTypes.get(t).counts_against_budget) continue;
    usedByType[t] = (usedByType[t] || 0) + 1;
  }

  // Build per-type breakdown
  var types = {};
  var typeNames = pageTypes.listAll();
  var ctx = { tracked_keywords_p1_count: p1Count };

  for (var k = 0; k < typeNames.length; k++) {
    var typeName = typeNames[k];
    var spec = pageTypes.get(typeName);
    if (!spec.counts_against_budget) {
      // Non-budgeted types still listed for completeness
      types[typeName] = {
        type: typeName,
        label: spec.label,
        budgeted: false,
        total: null,
        used: usedByType[typeName] || 0,
        remaining: null,
        addon_purchasable: !!spec.addon_tier_keys,
        addon_tier_keys: spec.addon_tier_keys || null,
      };
      continue;
    }

    var defaultCount = pageTypes.defaultCountFor(typeName, ctx);
    var addonCount = 0;
    if (spec.addon_tier_keys) {
      for (var m = 0; m < spec.addon_tier_keys.length; m++) {
        addonCount += addonByTierKey[spec.addon_tier_keys[m]] || 0;
      }
    }
    var total = defaultCount + addonCount;
    var used = usedByType[typeName] || 0;

    types[typeName] = {
      type: typeName,
      label: spec.label,
      budgeted: true,
      total: total,
      default_count: defaultCount,
      addon_count: addonCount,
      used: used,
      remaining: Math.max(0, total - used),
      over_budget: used > total,
      addon_purchasable: !!spec.addon_tier_keys,
      addon_tier_keys: spec.addon_tier_keys || null,
    };
  }

  return {
    contact_id: contactId,
    site_map_id: siteMap ? siteMap.id : null,
    types: types,
    overall: {
      total: Object.keys(types).reduce(function(s, t) {
        return s + (types[t].budgeted ? types[t].total : 0);
      }, 0),
      used: Object.keys(types).reduce(function(s, t) {
        return s + (types[t].used || 0);
      }, 0),
    },
    context: {
      tracked_keywords_p1: p1Count,
      team_size: contact ? contact.team_size : null,
      num_locations: contact ? contact.num_locations : null,
      plan_tier: contact ? contact.plan_tier : null,
    },
  };
}

// Check whether adding one more page of a given type would exceed budget.
// Useful for site-map UI to gate the "Add page" button.
async function canAdd(contactId, type) {
  var snapshot = await computeForContact(contactId);
  var t = snapshot.types[type];
  if (!t) return { allowed: false, reason: 'unknown_type' };
  if (!t.budgeted) return { allowed: true, reason: 'not_budgeted' };
  if (t.remaining > 0) return { allowed: true, remaining: t.remaining };
  return {
    allowed: false,
    reason: 'budget_exhausted',
    addon_purchasable: t.addon_purchasable,
    addon_tier_keys: t.addon_tier_keys,
  };
}

module.exports = {
  computeForContact: computeForContact,
  canAdd: canAdd,
  categoryToType: categoryToType,
  SITEMAP_CATEGORY_TO_TYPE: SITEMAP_CATEGORY_TO_TYPE,
  BUDGET_CONSUMING_STATUSES: BUDGET_CONSUMING_STATUSES,
};
