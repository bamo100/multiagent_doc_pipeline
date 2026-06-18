# Architecture decisions and tradeoffs

<!-- This document exists because hiring managers reading a portfolio repo
want to see *judgment*, not just working code. The decisions below are
the ones worth discussing in an interview. -->

## 1. Why LangGraph instead of a plain async function chain

**Decision:** A state graph where agents can loop, retry, and branch
based on runtime conditions.

**Rejected:** `await classify() → await extract() → await validate()` in
a single linear function.

**Why:** A fixed chain can't:
- retry just the validation step without re-paying for extraction
- swap models per-node (cheaper validator, stronger extractor)
- add a retry loop later without restructuring everything

**Tradeoff:** LangGraph adds orchestration overhead. For a
single-document-type pipeline it would be overkill. It earns its place
here because the pipeline handles multiple document types with different
extraction logic but a shared validation and review path.

## 2. Why Zod for schemas instead of plain TypeScript interfaces

**Decision:** All document schemas are Zod objects, not `interface` or
`type` declarations.

**Why:** TypeScript types are erased at runtime. Zod gives us:
- runtime validation of every model response with the same schema the
  type system already knows about (one source of truth)
- `.parse()` that throws on invalid output, triggering the retry loop in
  `base.ts` automatically
- `z.infer<typeof Schema>` for free TypeScript types — no duplication

**Tradeoff:** Slightly more verbose schema declarations. The payoff is
catching model hallucinations at the boundary, not deep in business logic.

## 3. Why per-document-type extractors instead of one generic extractor

**Decision:** Separate prompts and schemas per document type (invoice,
contract, receipt), registered in an `EXTRACTORS` map.

**Rejected:** One extractor with a union schema covering all possible
fields across document types.

**Why:** A generic schema either becomes enormous (hurts extraction
accuracy) or forces every document into a lowest-common-denominator shape
that loses type-specific structure (line items in an invoice vs. clauses
in a contract).

**Tradeoff:** Adding a new document type requires writing a new schema
and prompt. This is more upfront work but each extractor stays small,
testable, and independently improvable.

## 4. Why confidence scoring is per-field, not per-document

**Decision:** The validator returns a confidence score for each extracted
field.

**Why:** A document is rarely "all wrong" or "all right." An invoice
might have a perfectly clear total but an ambiguous due date. Per-document
confidence would either flag the whole document (wasting reviewer time on
9 correct fields) or pass it through with one bad field silently
persisted.

**Tradeoff:** Makes the review queue API more granular. The frontend that
would consume it would need to highlight specific fields, not just "this
document needs review" — that UI is intentionally out of scope for v1.

## 5. Why the confidence score comes from a second model call

**Decision:** A separate validator call reviews the extraction output and
assigns confidence, rather than relying on logprobs from the extraction call.

**Rejected:** Using logprobs as a confidence proxy.

**Why:** Logprobs measure how *predictable* a token was, not whether it's
*correct*. A model can be highly confident about a plausible-but-wrong
number (e.g. confusing a PO number with an invoice number). A second pass
that cross-checks extracted fields against each other and against the
source text catches a different class of error.

**Tradeoff:** ~2x the API cost per document. This is controlled via
`ENABLE_VALIDATOR_PASS` so the cost is visible and toggleable — exactly
the lever the observability dashboard project is designed to help you
measure and tune.

## Known limitations / explicitly out of scope for v1

- **OCR**: assumes text-extractable PDFs. Scanned documents would need a
  pre-processing step (e.g. AWS Textract, or a vision-capable model pass).
  Straightforward to add as a new graph node.
- **Review UI**: the review queue is a JSON API only. A real team would
  wrap this in Retool or an internal admin panel.
- **Multi-language**: prompts are English-only.
- **Streaming**: the Express endpoints wait for the full pipeline result
  before responding. For large documents, streaming status updates via
  SSE or WebSockets would improve UX — not needed for the portfolio demo.
- **Cost persistence**: token usage is logged to `console.log`. The
  observability dashboard project is the natural place to persist and
  visualise this.
