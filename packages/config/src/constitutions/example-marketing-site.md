---
product: example-marketing-site
version: 1
checkers:
  - compile
  - links
  - accessibility
  - tests
  - lint
  - custom_brand_voice
  - custom_seo
enforced_on: [plan, build, check]
---

# Example Constitution — Marketing Site Generator

> Example constitution shipped with the factory to demonstrate the format.
> Copy it and adapt the standards to your own product.

## Purpose

A generator that turns a product brief into a deployable static marketing site
(HTML/CSS/JS plus a brand kit). The output is static files the user deploys to any
static host.

## Standards

### Brand Consistency

- All copy must match the brand voice defined in the spec (tone, register, vocabulary)
- Color palette must use the exact hex values from the brand spec — no approximations
- Logo must be placed on every page at the specified size and position
- Typography must use the font families from the brand spec

### Accessibility (WCAG 2.2 AA)

- Every `<img>` must have meaningful `alt` text (not filename, not "image")
- All interactive elements must be keyboard-navigable
- Color contrast must meet WCAG AA (4.5:1 normal text, 3:1 large text)
- Every form input must have an associated `<label>`
- Heading hierarchy must be sequential (no skipping h2→h4)
- A skip-to-content link must be present on every page

### SEO

- Every page must have a unique `<title>` (≤60 chars)
- Every page must have a `<meta name="description">` (≤155 chars)
- `og:` tags must be present and resolve to real URLs
- `sitemap.xml` must be present and list every page
- `robots.txt` must be present and allow crawling
- Structured data (JSON-LD) must be present on product/service pages

### Link Integrity

- All internal links must resolve to real files in the output
- All external links must return HTTP 200 (checked at build time)
- No `href="#"` placeholder links in shipped output
- Footer links (privacy, terms, contact) must all resolve

### Code Quality

- HTML must be valid
- CSS must have no unused rules (purged)
- JS must pass linting with no errors
- No inline event handlers (`onclick=`, `onload=`) — use `addEventListener`
- No `console.log` / debug statements in shipped output

### Payments (optional)

- If the site sells, payment links must match the spec's product names and prices exactly
- Success/cancel URLs must resolve to real pages
- Any webhook endpoint must be a valid HTTPS URL

## Quality Gates

All checkers must pass before the PR is marked ready:

1. `compile` — HTML/CSS/JS builds without errors
2. `lint` — Linting passes
3. `links` — All links resolve (internal + external)
4. `accessibility` — WCAG 2.2 AA checks (light + dark mode)
5. `tests` — Test suite passes
6. `custom_brand_voice` — Copy matches the brand voice spec
7. `custom_seo` — SEO checks (title, meta, OG, sitemap, robots, JSON-LD)

## Dispute Rules

- If a checker flags copy as "off-brand," the boss compares against the brand voice
  spec. If the copy matches the spec, the checker is overruled. If the spec is
  ambiguous, the boss updates the spec and re-runs.
- If the accessibility checker flags something the worker argues is intentional
  (e.g. decorative images with empty `alt`), the boss checks the WCAG 2.2 AA spec.
  Decorative images with `alt=""` are valid; the checker is overruled.
- SEO length limits are guidelines, not hard limits. ±10% tolerance. Beyond that,
  the worker must justify and the boss approves.

## Non-Goals

- Performance optimization (Core Web Vitals) — not checked in this example
- Cross-browser testing beyond a single evergreen browser
- Content management — output is static files
- Analytics/tracking — added by the user post-deploy
