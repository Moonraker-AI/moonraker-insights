# Plan Terminology

Canonical vocabulary for how Moonraker refers to its five service plans. This
lives in the repo so the terms stay stable when Chris isn't in the room and
so new code, emails, and client-facing copy all use the same language.

## The five plans

| Display name | `plan_tier` | `billing_cadence` | `commitment_months` | Price structure | PG eligible? | Includes website? |
|---|---|---|---|---|---|---|
| Annual Upfront | `annual` | `upfront` | `12` | $20,000 one-time | yes | yes (only this tier) |
| Annual Quarterly | `annual` | `quarterly` | `12` | $5,000 x 4 quarterly | yes | no |
| Annual Monthly | `annual` | `monthly` | `12` | $1,667 x 12 monthly | yes | no |
| Flexible Quarterly | `flexible` | `quarterly` | `0` | $5,000/qtr, no end date | no | no |
| Flexible Monthly | `flexible` | `monthly` | `0` | $1,667/mo, no end date | no | no |

## The mental model in one sentence

`plan_tier` tells you whether there's a 12-month commitment (and therefore
whether the guarantee is on the table). `billing_cadence` tells you how
often Stripe charges. `commitment_months` is the single field the code
gates on: everything else is presentational.

## Naming discipline

"Paying monthly" is ambiguous on its own. It's true of both *Annual
Monthly* (committed, PG-eligible) and *Flexible Monthly* (no commitment,
no PG). Always pair the two words: "Annual Monthly" or "Flexible Monthly."
That's exactly why the legacy `plan_type` field failed us: it collapsed
tier and cadence into one noun.

## Legacy `plan_type` mapping

During the transition, we continue writing the legacy `plan_type` field in
parallel so older read paths keep working. New code should prefer
`plan_tier` + `billing_cadence` + `commitment_months`.

| Legacy `plan_type` | Maps to |
|---|---|
| `annual` | Any Annual tier (Upfront / Quarterly / Monthly, disambiguated by `billing_cadence`) |
| `quarterly` | Flexible Quarterly |
| `monthly` | Flexible Monthly |
| `null` | Pre-checkout (no plan selected yet) |

## The admin source of truth

`/admin/clients?slug=<slug>` -> Billing tab -> Campaign Commitment card.
The Edit button writes all five fields atomically:

- `plan_tier`
- `billing_cadence`
- `commitment_months`
- `plan_amount_cents` (with custom override allowed)
- `commitment_start_at`
- `payment_method`
- `plan_type` (legacy, written in parallel until retired)

The five plan presets in the dropdown are the only canonical combinations
the UI will write. If a client needs a custom combination (e.g. a
negotiated $1,225/mo rate that's still Annual Monthly), use the Plan
Amount override to set the rate while keeping the tier/cadence/commitment
clean.

## Performance Guarantee eligibility

A single rule: `commitment_months >= 12`. Anything else is ineligible.
The eligibility badge on the Campaign Commitment card and the binding
configurator on the client onboarding page both derive from this field.
