---
product: example-client-delivery
version: 1
checkers:
  - compile
  - tests
  - lint
  - links
  - accessibility
  - custom_brand_match
  - custom_client_spec
enforced_on: [plan, build, check]
---

# Example Constitution — Client Site Delivery

> Example constitution for building a client website against a supplied brand
> guide and technical spec, where a human reviews only the final output.

## Purpose
Build and self-QA a client website against the client's brand guide and technical
spec (both provided per project). Demonstrates matching output to an external,
per-project standard rather than a fixed one.

## Standards

### Client Brand Adherence
- All copy must match the client's brand voice guide (provided per project)
- Colors must match the client's palette (exact hex values from the brief)
- Typography must use the client's specified font families and weights
- Logo placement must follow the client's brand guidelines
- Tone must match the client's industry (formal for legal/medical, conversational for retail, etc.)

### Technical Specification
- Every page in the client spec must be present in the output
- All required sections (hero, services, about, contact, etc.) must be implemented
- Responsive breakpoints must match the spec (mobile-first: 375px, 768px, 1024px, 1440px)
- Performance budget: LCP < 2.5s, CLS < 0.1, INP < 200ms on the target pages
- No framework dependencies unless the client spec requires it

### Accessibility (WCAG 2.2 AA)
- Same standards as the marketing-site example (see `example-marketing-site.md`)
- Additional: if the client has a disability statement, it must be present and accurate

### SEO & Metadata
- Title tags match the client's SEO strategy from the brief
- Meta descriptions present and within limits
- OG tags present and resolve to the client's domain
- Sitemap and robots.txt present and correct
- JSON-LD structured data for the client's business type

### Link Integrity
- All internal links resolve to real files
- All external links return HTTP 200
- Social links resolve to the client's actual profiles
- No placeholder or dead links

## Quality Gates
1. `compile` — Site builds without errors
2. `lint` — Linting passes
3. `tests` — Test suite passes
4. `links` — All links resolve
5. `accessibility` — WCAG 2.2 AA (light + dark mode)
6. `custom_brand_match` — Output matches the client brand guide
7. `custom_client_spec` — All spec requirements present

## Dispute Rules
- If the brand-match checker flags something the worker says is "close enough,"
  the boss compares against the client brand guide hex values / font names. Exact
  match is required for colors and fonts. Tone is judged against the voice guide.
- If the client-spec checker flags a missing section the worker says is "implied,"
  the boss reads the spec. If the spec lists it as required, it must be present.
  "Implied" is not an acceptable justification for a missing required section.
- Performance budget: ±20% tolerance on LCP/CLS/INP. The worker must justify any
  miss and propose a fix timeline if it exceeds tolerance.

## Non-Goals
- Content writing (the client provides copy; the factory formats and places it)
- CMS integration
- E-commerce beyond simple payment links
- Email marketing integration
