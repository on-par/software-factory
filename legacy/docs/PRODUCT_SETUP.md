# Product Setup Guide

This guide walks through integrating a new product (or existing product) into the Software Factory.

## 1. Write a Constitution

Create `constitutions/<your-product>.md`. Start from `constitutions/_template.md`.

Key sections:
- **Standards** — concrete, testable criteria. Every standard should be machine-verifiable.
- **Quality Gates** — list which checkers run. Use built-in checkers (`compile`, `tests`, `lint`, `links`, `accessibility`) and add custom ones (`custom_*`).
- **Dispute Rules** — define how the boss arbitrates. Reference the standards, not opinion.

## 2. Write Custom Checkers (Optional)

If your constitution references `custom_*` checkers, they run as agent prompts. The checker agent:
1. Reads the constitution to understand what to verify
2. Inspects the worktree
3. Returns a JSON verdict

You don't need to write any code for custom checkers — the constitution's standards section IS the checker prompt. Just make sure the standard is specific enough for an agent to verify.

For code-based custom checkers (faster, no model cost), add a bash function to `lib/checkers/custom.sh`:

```bash
check_custom_my_check() {
  local wt="$1" spec="$2" constitution_body="$3"
  # ... verification logic ...
  jq -n --arg r "$result" --arg d "$details" \
    '{checker: "custom_my_check", result: $r, details: $d}'
}
```

## 3. Configure Models (Optional)

Edit `config/models.json` to add/remove models or change tier priorities.

The default config supports:
- **Anthropic** (Claude Opus, Sonnet) — requires `ANTHROPIC_API_KEY`
- **OpenAI** (GPT-5.5, GPT-4.1-mini) — requires `OPENAI_API_KEY`
- **Ollama** (GLM 5.2, Qwen 3.5 Coder) — local, no key needed
- **DeepSeek** — requires `DEEPSEEK_API_KEY`

In BYOK mode (`FACTORY_BYOK=1`), only models whose API keys are present are used.

## 4. Set Up Your Repo

In your product's git repo (must have a GitHub remote):

```bash
cd /path/to/your-repo
factory init
factory constitution --product your-product
factory triage
# review the proposed queue
mv .factory/queue.proposed .factory/queue
factory run
```

## 5. Monitor

```bash
factory status    # queue, events, PRs, models
tail -f .factory/events.ndjson | jq .
factory cost      # cost tracking
```

## Example Setups

### Marketing site generator
```bash
cd /path/to/your-site-generator
factory init
factory constitution --product example-marketing-site
factory triage
factory run
```

Constitution: `constitutions/example-marketing-site.md`
Checkers: compile, links, accessibility, tests, lint, custom_brand_voice, custom_seo

### Data analysis app
```bash
cd /path/to/your-data-app
factory init
factory constitution --product example-data-app
factory triage
factory run
```

Constitution: `constitutions/example-data-app.md`
Checkers: compile, tests, lint, custom_data_verification, custom_report_validation

### Client site delivery
```bash
cd /path/to/client-project
factory init
factory constitution --product example-client-delivery
factory triage
factory run
```

Constitution: `constitutions/example-client-delivery.md`
Checkers: compile, tests, lint, links, accessibility, custom_brand_match, custom_client_spec

For client delivery, the constitution applies to all client projects. The client's brand guide and technical spec are provided per-issue and referenced in the constitution's standards.