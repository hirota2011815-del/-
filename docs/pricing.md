# Claude pricing reference

All prices in USD. `MTok` = one million tokens.

Source: [Pricing — Claude Platform Docs](https://platform.claude.com/docs/en/about-claude/pricing)
· Last verified: **2026-09-20**

> Prices change. Treat this file as a snapshot for planning and cost modelling, and
> check [claude.com/pricing](https://claude.com/pricing) or the docs page above before
> committing to a number in a contract or a billing calculation.

## Contents

- [Model pricing](#model-pricing)
- [Batch pricing](#batch-pricing)
- [Prompt caching](#prompt-caching)
- [Fast mode](#fast-mode)
- [Long context](#long-context)
- [Data residency](#data-residency)
- [Cloud platforms](#cloud-platforms)
- [Tool pricing](#tool-pricing)
- [Claude Managed Agents](#claude-managed-agents)
- [Worked examples](#worked-examples)
- [Cost optimization](#cost-optimization)
- [Discounts, rate limits, and billing](#discounts-rate-limits-and-billing)
- [FAQ](#faq)

## Model pricing

| Model | Base input | 5m cache write | 1h cache write | Cache hits & refreshes | Output |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok [^1] | $50 / MTok |
| Claude Mythos 5.1 [^2] | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok [^1] | $50 / MTok |
| Claude Fable 5 | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
| Claude Mythos 5 [^2] | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.7 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.6 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.1 [^3] | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Opus 4 [^4] | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4.5 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Sonnet 4 [^3] | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
| Claude Haiku 4.5 | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $5 / MTok |
| Claude Haiku 3.5 [^3] | $0.80 / MTok | $1 / MTok | $1.60 / MTok | $0.08 / MTok | $4 / MTok |

[^1]: Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced at 0.025x
      the base input price. All other models use the standard 0.1x multiplier.
[^2]: [Limited availability](https://anthropic.com/glasswing).
[^3]: [Retired, except on Bedrock and Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations).
[^4]: [Retired, except on Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations).

**Claude Sonnet 5 pricing is settled.** The $2/$10 per-MTok input/output rate announced at
launch as introductory pricing through August 31, 2026 is now the standard price. The
increase to $3/$15 that had been scheduled for September 1, 2026 will not happen.

**Tokenizer change affects cost comparisons.** Claude 4.7 and later models, plus Claude
Mythos Preview, use a newer tokenizer that produces roughly **30% more tokens for the same
text** (the exact increase depends on content and workload shape). Claude Sonnet 4.6 and
earlier use the previous tokenizer. When comparing per-MTok rates across that boundary,
re-baseline your token counts with the
[token counting endpoint](https://platform.claude.com/docs/en/build-with-claude/token-counting)
— the rate card alone will mislead you.

## Batch pricing

The [Batch API](https://platform.claude.com/docs/en/build-with-claude/batch-processing)
processes large volumes of requests asynchronously at a **50% discount on both input and
output tokens**.

| Model | Batch input | Batch output |
| :--- | :--- | :--- |
| Claude Fable 5.1 | $5 / MTok | $25 / MTok |
| Claude Mythos 5.1 [^2] | $5 / MTok | $25 / MTok |
| Claude Fable 5 | $5 / MTok | $25 / MTok |
| Claude Mythos 5 [^2] | $5 / MTok | $25 / MTok |
| Claude Opus 5 | $2.50 / MTok | $12.50 / MTok |
| Claude Opus 4.8 | $2.50 / MTok | $12.50 / MTok |
| Claude Opus 4.7 | $2.50 / MTok | $12.50 / MTok |
| Claude Opus 4.6 | $2.50 / MTok | $12.50 / MTok |
| Claude Opus 4.5 | $2.50 / MTok | $12.50 / MTok |
| Claude Opus 4.1 [^3] | $7.50 / MTok | $37.50 / MTok |
| Claude Opus 4 [^4] | $7.50 / MTok | $37.50 / MTok |
| Claude Sonnet 5 | $1 / MTok | $5 / MTok |
| Claude Sonnet 4.6 | $1.50 / MTok | $7.50 / MTok |
| Claude Sonnet 4.5 | $1.50 / MTok | $7.50 / MTok |
| Claude Sonnet 4 [^3] | $1.50 / MTok | $7.50 / MTok |
| Claude Haiku 4.5 | $0.50 / MTok | $2.50 / MTok |
| Claude Haiku 3.5 [^3] | $0.40 / MTok | $2 / MTok |

Batch is not available with [fast mode](#fast-mode) or with Claude Managed Agents sessions.

## Prompt caching

[Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
reuses previously processed portions of a prompt across requests, so a large system
prompt, document, or conversation history is read from cache at a fraction of the standard
input price instead of being reprocessed.

Two ways to enable it:

- **Automatic caching** — a single `cache_control` field at the top level of the request.
  The system manages cache breakpoints as the conversation grows. Recommended starting point.
- **Explicit cache breakpoints** — `cache_control` on individual content blocks, for
  fine-grained control over exactly what gets cached.

Multipliers relative to the model's base input rate:

| Cache operation | Multiplier | Duration |
| :--- | :--- | :--- |
| 5-minute cache write | 1.25x base input | Cache valid for 5 minutes |
| 1-hour cache write | 2x base input | Cache valid for 1 hour |
| Cache read (hit) | 0.1x base input (0.025x on Claude Fable 5.1 and Claude Mythos 5.1) | Same duration as the preceding write |

Write tokens are charged when content is first stored; read tokens when a later request
retrieves it. At the standard 0.1x read rate, caching pays for itself after **one** read on
the 5-minute duration (1.25x write) and after **two** reads on the 1-hour duration (2x write).
On Claude Fable 5.1 and Claude Mythos 5.1 a hit costs 2.5% of standard input ($0.25 / MTok).

These multipliers stack with other modifiers, including the Batch API discount and data
residency.

## Fast mode

[Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode) (research
preview) delivers significantly faster output for Claude Opus 5 and Claude Opus 4.8 at
premium pricing, applied across the full context window including requests over 200k input
tokens.

| Model | Input | Output |
| :--- | :--- | :--- |
| Claude Opus 5 / Claude Opus 4.8 | $10 / MTok | $50 / MTok |

- Claude API (first-party) only — not on Claude Platform on AWS or partner-operated clouds.
- Not available on Claude Opus 4.7 (`speed: "fast"` returns an error) or Claude Opus 4.6
  (runs at standard speed, billed at standard rates).
- Prompt caching and data residency multipliers apply **on top of** fast mode pricing.
- Not available with the Batch API.

## Long context

Claude 4.6 and later models, plus
[Claude Mythos Preview](https://anthropic.com/glasswing), include the full
[1M token context window](https://platform.claude.com/docs/en/build-with-claude/context-windows)
at standard pricing — a 900k-token request is billed at the same per-token rate as a
9k-token request. Prompt caching and batch discounts apply at standard rates across the
full window.

## Data residency

For Claude 4.6 and later, requesting US-only inference via `inference_geo: "us"` applies a
**1.1x multiplier to all token categories** — input, output, cache writes, and cache reads.
Global routing (the default) uses standard pricing.

- Applies to the Claude API (first-party) and Claude Platform on AWS.
- On Claude in Microsoft Foundry, the same 1.1x applies to deployments using the US Data
  Zone Standard deployment type.
- Bedrock and Google Cloud are partner-operated and have independent regional pricing.
- Earlier models don't support `inference_geo`; sending it returns a 400.

See [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency).

## Cloud platforms

### Partner-operated (the cloud provider invoices you)

- [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- [Google Cloud pricing](https://cloud.google.com/vertex-ai/generative-ai/pricing#claude-models)

**Regional endpoint premium.** Starting with Claude Sonnet 4.5, Haiku 4.5, and Opus 4.5 (and
all later models), Bedrock offers global and regional endpoints, and Google Cloud offers
global, multi-region, and regional endpoints. **Regional and multi-region endpoints carry a
10% premium over global endpoints.** Claude Opus 4.1 and earlier keep their existing pricing.
The Claude API is global by default; for first-party residency options see
[Data residency](#data-residency).

### Anthropic-operated, billed through a marketplace

[Claude Platform on AWS](https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws)
(AWS Marketplace) and
[Claude in Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry)
(Azure Marketplace) both bill in **Claude Consumption Units (CCUs)**. Token usage is rated in
USD at the standard per-model, per-feature rates above, any negotiated discount is applied,
and the result is converted to CCUs at **$0.01 per CCU** (100 CCU = $1.00) and metered hourly.
Your cloud bill shows a single CCU line item.

| Concept | Details |
| :--- | :--- |
| Billing unit | Claude Consumption Unit (CCU) |
| CCU price | $0.01 per CCU (fixed; discounts apply at token-to-CCU conversion, not to the CCU price) |
| Conversion | Token usage rated in USD at standard rates, then converted at $0.01 per CCU |
| Billing cadence | Hourly metering to the marketplace; monthly invoices |
| Payment model | Arrears only (postpaid); no prepaid credits |
| Discounts | Applied as fewer CCUs metered |
| Tax | Pre-tax metering; the marketplace handles tax |
| Cost visibility | AWS: real-time breakdown in the Claude Console, aggregated CCU in AWS Cost Explorer. Azure: aggregated CCU in Azure Cost Management |

On both, US-only inference (`inference_geo: "us"` on AWS, the US Data Zone Standard
deployment type on Foundry) applies the same 1.1x multiplier described in
[Data residency](#data-residency).

**Private offers (AWS).** Signing up on the AWS Console *Claude Platform on AWS* service page
looks up any private offer on your account and prompts you to accept it in AWS Marketplace.
If you have an existing Amazon Bedrock private offer, contact your Anthropic or AWS account
representative **before** starting — discounts cannot be applied retroactively to usage
incurred before the private offer is accepted.

## Tool pricing

Tool use is priced on (1) total input tokens including the `tools` parameter, (2) output
tokens generated, and (3) for server-side tools, additional usage-based charges. Client-side
tools cost the same as any other request.

Extra tokens come from the `tools` parameter (names, descriptions, schemas), `tool_use`
blocks, `tool_result` blocks, and an automatically inserted tool-use system prompt.

### Tool-use system prompt overhead

Assumes at least one tool is provided. With no `tools`, a tool choice of `none` adds 0 tokens.

| Model | `auto`, `none` | `any`, `tool` |
| :--- | :--- | :--- |
| Claude Opus 5 | 286 tokens | 406 tokens |
| Claude Opus 4.8 | 290 tokens | 410 tokens |
| Claude Opus 4.7 | 675 tokens | 804 tokens |
| Claude Opus 4.6 | 497 tokens | 589 tokens |
| Claude Opus 4.5 | 496 tokens | 588 tokens |
| Claude Opus 4.1 [^3] | 313 tokens | 315 tokens |
| Claude Opus 4 [^4] | 313 tokens | 315 tokens |
| Claude Sonnet 5 | 354 tokens | 474 tokens |
| Claude Sonnet 4.6 | 497 tokens | 589 tokens |
| Claude Sonnet 4.5 | 496 tokens | 588 tokens |
| Claude Sonnet 4 [^3] | 313 tokens | 315 tokens |
| Claude Haiku 4.5 | 496 tokens | 588 tokens |
| Claude Haiku 3.5 [^3] | 264 tokens | 355 tokens |

### Per-tool charges

| Tool | Additional cost |
| :--- | :--- |
| **Web search** | **$10 per 1,000 searches**, plus standard token costs for search-generated content. Each search counts as one use regardless of result count; errored searches are not billed. Results count as input tokens both within a turn's search iterations and in later turns. |
| **Web fetch** | **No additional charge** — standard token costs only for fetched content that enters the context. Use `max_content_tokens` to cap it. |
| **Code execution** | **Free when used with web search or web fetch** (`web_search_20260209` / `web_fetch_20260209` or later). Otherwise billed by execution time: 5-minute minimum per execution, **1,550 free hours per organization per month**, then **$0.05 per hour, per container**. If files are included in the request, execution time is billed even if the tool is never called, because files are preloaded onto the container. |
| **Bash tool** | Definition adds **325 input tokens** on Claude Opus 5 / 4.8 / 4.7, **244 tokens** on Claude Opus 4.6, Claude Sonnet 4.6, and earlier — on top of the tool-use system prompt. Command output, error messages, and large file contents add more. |
| **Text editor tool** | `text_editor_20250429` (Claude 4.x) adds **700 input tokens**. |
| **Computer use** | `computer_toolset_20260801` with default members adds **~4,500 input tokens** (~4,520 on Claude Fable 5, Mythos 5, Opus 5, Opus 4.8; ~4,590 on Claude Sonnet 5). Disabling `zoom` via `configs` removes ~410. Older `computer_20251124` / `computer_20250124`: 466–499 system prompt tokens plus ~735 tokens per tool definition. Screenshots and zoom images are billed as image input. |
| **Browser use** | `browser_toolset_20260801` with default members adds **~6,600 input tokens** (~6,610 on Claude Fable 5, Mythos 5, Opus 5, Opus 4.8; ~6,670 on Claude Sonnet 5). All four optional members add ~880 more. Screenshots, accessibility trees, page text, and console/network entries add token cost. |

Estimate overhead in advance with the
[token counting endpoint](https://platform.claude.com/docs/en/build-with-claude/token-counting);
the exact count for a request is reported in the response `usage`.

Rough web fetch token sizes: an average 10 kB page ≈ 2,500 tokens, a 100 kB documentation
page ≈ 25,000 tokens, a 500 kB research paper PDF ≈ 125,000 tokens.

## Claude Managed Agents

[Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) bills on two
dimensions: **tokens** and **session runtime**.

**Tokens** are billed at the standard [model pricing](#model-pricing) rates. Prompt caching
multipliers apply identically, web search inside a session costs the standard $10 per 1,000
searches, fast mode premium pricing applies when an agent's `model.speed` is `"fast"`, and
the 1.1x data residency multiplier applies when `model.inference_geo` is pinned to `"us"`.
On Claude Platform on AWS, both token and runtime charges convert to CCUs at the standard rate.

Two Messages API modifiers do **not** apply:

| Modifier | Why |
| :--- | :--- |
| Batch API discount | Sessions are stateful and interactive; there is no batch mode. |
| Partner cloud platform pricing | Managed Agents is not available on partner-operated clouds. |

**Session runtime:**

| SKU | Rate | Metering |
| :--- | :--- | :--- |
| Session runtime | $0.08 per session-hour | `running` status duration |

Runtime is measured to the millisecond and accrues only while the session is `running`. Time
spent `idle` (waiting on your next message or a tool confirmation), `rescheduling`, or
`terminated` doesn't count. Session runtime **replaces** code execution container-hour
billing — you are not charged for both.

## Worked examples

### A one-hour Managed Agents coding session on Claude Opus 5

50,000 input tokens, 15,000 output tokens:

| Line item | Calculation | Cost |
| :--- | :--- | :--- |
| Input tokens | 50,000 × $5 / 1,000,000 | $0.25 |
| Output tokens | 15,000 × $25 / 1,000,000 | $0.375 |
| Session runtime | 1.0 hour × $0.08 | $0.08 |
| **Total** | | **$0.705** |

With prompt caching active and 40,000 of those input tokens served as cache reads:

| Line item | Calculation | Cost |
| :--- | :--- | :--- |
| Uncached input tokens | 10,000 × $5 / 1,000,000 | $0.05 |
| Cache read tokens | 40,000 × $5 × 0.1 / 1,000,000 | $0.02 |
| Output tokens | 15,000 × $25 / 1,000,000 | $0.375 |
| Session runtime | 1.0 hour × $0.08 | $0.08 |
| **Total** | | **$0.525** |

### 10,000 support tickets on Claude Haiku 4.5

At ~3,700 tokens per conversation and $1 / MTok input, $5 / MTok output: **~$37.00 per 10,000
tickets**. Walkthrough in the
[customer support agent guide](https://platform.claude.com/docs/en/about-claude/use-case-guides/customer-support-chat).

## Cost optimization

1. **Use appropriate models** — Haiku for simple tasks, Sonnet for most production
   workloads, Opus for the most complex reasoning.
2. **Implement prompt caching** — cuts the cost of repeated context; see the payback rules
   in [Prompt caching](#prompt-caching).
3. **Batch operations** — 50% off for anything not latency-sensitive.
4. **Monitor usage patterns** — track token consumption to find optimization opportunities.

For high-volume agent applications, contact the
[enterprise sales team](https://claude.com/contact-sales) about custom pricing.

## Discounts, rate limits, and billing

**Rate limits** vary by usage tier — Start (entry-level), Build (growing applications), and
Scale (highest standard limits). See
[Rate limits](https://platform.claude.com/docs/en/api/rate-limits). For limits beyond Scale,
[contact sales](https://claude.com/contact-sales).

**Volume discounts** are negotiated case by case. Standard tiers pay the rates in
[Model pricing](#model-pricing); enterprise customers can
[contact sales](mailto:sales@anthropic.com) for custom pricing, and academic and research
discounts may be available.

**Enterprise pricing** covers custom rate limits, volume discounts, dedicated support, and
custom terms — via [sales@anthropic.com](mailto:sales@anthropic.com) or the
[Claude Console](https://platform.claude.com/settings/limits).

**Billing** is based on actual monthly usage, in USD, by credit card or invoice. Usage
tracking lives in the [Claude Console](https://platform.claude.com/).

## FAQ

**How is token usage calculated?** Tokens are pieces of text the models process. As a rough
estimate, 1 token ≈ 4 characters ≈ 0.75 words in English; the exact count varies by language
and content type. Note the [tokenizer change](#model-pricing) on Claude 4.7 and later.

**Are there free tiers or trials?** New users get a small amount of free credits to test the
API. [Contact sales](mailto:sales@anthropic.com) about extended trials for enterprise
evaluation.

**How do discounts stack?** Batch API and prompt caching discounts combine, and both stack
with the data residency and fast mode modifiers.

**What payment methods are accepted?** Major credit cards for standard accounts; enterprise
customers can arrange invoicing and other methods.

For other pricing questions, contact [support@anthropic.com](mailto:support@anthropic.com).
