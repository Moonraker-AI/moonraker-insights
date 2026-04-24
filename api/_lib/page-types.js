// /api/_lib/page-types.js
// Single source of truth for Pagemaster v2 page taxonomy.
//
// Defines:
//   - Valid page_type values
//   - Default per-plan allowances (CORE Marketing Campaign baseline)
//   - Whether each type counts against budget
//   - Default nav_section, footer_section, nav_order
//   - Which addon SKU adds capacity to each type
//
// Budget rule: a page consumes 1 from its bucket when the site_map decision
// is `build` or `update_as_target`. `keep` and `remove` are free.
//
// Budget = (plan default for type) + (sum of addon_orders.qty for that type's
// addon tier_key, where status='paid'). Subtract count of build/update pages
// of that type currently in site_map_pages to get remaining.

var TYPES = {
  homepage: {
    label: 'Homepage',
    default_count: 1,
    addon_tier_keys: null,         // not addon-purchasable
    counts_against_budget: true,
    nav_section: null,             // homepage has no nav entry, it IS the nav root
    nav_order: 0,
    footer_section: 'main',
    template: 'homepage',
    multi_per_client: false,
  },

  service: {
    label: 'Service Page',
    // Default is dynamic: equals the count of P1 tracked_keywords for the contact.
    // Resolved at budget-calculation time, not from a constant here.
    default_count: 'tracked_keywords_p1',
    addon_tier_keys: ['additional_service_page_ach', 'additional_service_page_cc'],
    counts_against_budget: true,
    nav_section: 'services',
    nav_order: 100,
    footer_section: 'main',
    template: 'service',
    multi_per_client: true,
  },

  location: {
    label: 'Location Page',
    default_count: 2,
    addon_tier_keys: ['additional_location_page_ach', 'additional_location_page_cc'],
    counts_against_budget: true,
    nav_section: 'locations',      // dropdown when 2+, replaced by location name when 1, hidden when 0
    nav_order: 200,
    footer_section: 'main',
    template: 'location',
    multi_per_client: true,
  },

  bio: {
    label: 'Bio Page',
    default_count: 10,
    addon_tier_keys: ['additional_bio_page_ach', 'additional_bio_page_cc'],
    counts_against_budget: true,
    nav_section: 'about',          // sub-items under About dropdown when 2-5 clinicians
    nav_order: 50,                 // sorted under About
    footer_section: 'main',
    template: 'bio',
    multi_per_client: true,
  },

  about_us: {
    label: 'About Us',
    default_count: 1,              // group practices only — solo practices skip
    addon_tier_keys: null,
    counts_against_budget: false,  // always included for group practices, no budget impact
    nav_section: 'about',
    nav_order: 1,                  // first item in About dropdown
    footer_section: 'main',
    template: 'about_us',
    multi_per_client: false,
  },

  faq_general: {
    label: 'General FAQ',
    default_count: 1,
    addon_tier_keys: null,
    counts_against_budget: false,
    nav_section: 'utility',
    nav_order: 900,
    footer_section: 'main',
    template: 'faq_general',
    multi_per_client: false,
  },

  contact: {
    label: 'Contact',
    default_count: 1,
    addon_tier_keys: null,
    counts_against_budget: false,
    nav_section: 'utility',
    nav_order: 999,                // far-right of nav
    footer_section: 'main',
    template: 'contact',
    multi_per_client: false,
  },

  privacy: {
    label: 'Privacy Policy',
    default_count: 1,
    addon_tier_keys: null,
    counts_against_budget: false,
    nav_section: null,
    nav_order: null,
    footer_section: 'legal',
    template: 'privacy',
    multi_per_client: false,
  },

  tos: {
    label: 'Terms of Service',
    default_count: 1,
    addon_tier_keys: null,
    counts_against_budget: false,
    nav_section: null,
    nav_order: null,
    footer_section: 'legal',
    template: 'tos',
    multi_per_client: false,
  },

  custom: {
    label: 'Custom / Resource Page',
    default_count: 0,              // no included custom pages, addon-only
    addon_tier_keys: ['additional_custom_page_ach', 'additional_custom_page_cc'],
    counts_against_budget: true,
    nav_section: 'resources',      // top-level when 2+, flat link when 1, hidden when 0
    nav_order: 700,
    footer_section: 'main',
    template: 'custom',
    multi_per_client: true,
  },
};

// Backward compat: v1 used 'faq' for the general FAQ type.
// Treat 'faq' as alias to 'faq_general' on lookups.
var TYPE_ALIASES = {
  faq: 'faq_general',
};

function get(type) {
  if (!type) return null;
  var resolved = TYPE_ALIASES[type] || type;
  return TYPES[resolved] || null;
}

function isValid(type) {
  return get(type) !== null;
}

function listAll() {
  return Object.keys(TYPES);
}

// Resolve the default count for a type, given a contact context.
// For most types this is a constant; for 'service' it's derived from
// the contact's P1 tracked_keywords count.
function defaultCountFor(type, ctx) {
  var spec = get(type);
  if (!spec) return 0;
  if (spec.default_count === 'tracked_keywords_p1') {
    return (ctx && typeof ctx.tracked_keywords_p1_count === 'number')
      ? ctx.tracked_keywords_p1_count
      : 0;
  }
  return spec.default_count;
}

// Default nav label for a page type, given context.
// Most types have a fixed label; bio/service/location use page_name.
function defaultNavLabelFor(type, page) {
  var spec = get(type);
  if (!spec) return page.page_name || '';
  // Pages with multi_per_client use page_name (e.g. "EMDR Therapy", "Sarah Jones")
  if (spec.multi_per_client) {
    return page.page_name || page.target_keyword || spec.label;
  }
  return spec.label;
}

module.exports = {
  TYPES: TYPES,
  ALIASES: TYPE_ALIASES,
  get: get,
  isValid: isValid,
  listAll: listAll,
  defaultCountFor: defaultCountFor,
  defaultNavLabelFor: defaultNavLabelFor,
};
