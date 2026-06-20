# Document Intelligence Pipeline (TypeScript)

A multi-agent pipeline designed for **structured extraction, validation, and human-in-the-loop review of business financial documents (Invoices, Receipts) and Legal Contracts**. It classifies incoming files, routes them to specialized extraction agents, validates data schemas, cross-checks mathematical consistency, and writes structured outputs to a PostgreSQL database—automatically escalating low-confidence results to a human review queue.

## Stack

- **Orchestration:** `@langchain/langgraph` (TypeScript SDK)
- **Model access:** `@openai/sdk`
- **Schema validation:** Zod (runtime + compile-time, one source of truth)
- **API layer:** Express
- **File upload:** Multer (in-memory, streams straight to pdf-parse)
- **Persistence:** PostgreSQL via `pg`

## Project layout

```
public/
└── index.html        Dashboard UI (HTML/CSS/JS)

src/
...
├── index.ts          Express server + API endpoints
├── config.ts         Settings from environment variables
├── schemas.ts        Zod schemas for documents and pipeline state
├── graph.ts          LangGraph state graph
├── db.ts             PostgreSQL pool + table initialisation
└── agents/
    ├── base.ts       Shared call wrapper (retry, logging)
    ├── classifier.ts Routes documents to the right extractor
    ├── extractor.ts  Per-document-type extraction agents
    └── validator.ts  Per-field confidence scoring

tests/
└── graph.test.ts     Pipeline tests with mocked agent calls (no API key needed)
```

## Architecture decisions

See `ARCHITECTURE.md` for the tradeoffs: why LangGraph instead of a fixed chain, why per-type extractors, why per-field confidence, why validation is a second model call, why review is async, and how human corrections are validated.

## Getting started

```bash
npm install
cp .env.example .env       # add ANTHROPIC_API_KEY and DATABASE_URL
npm run dev                # ts-node-dev with hot reload
```

**Access the Dashboard UI:**

Open `http://localhost:3006` in your web browser to use the graphical interface for uploading documents, resolving review items, and inspecting results.

Alternatively, you can use the command line:

**Upload a document:**

```bash
curl -X POST http://localhost:3006/documents \
  -F "file=@../samples/invoice_001.txt"
```

**Check review queue:**

```bash
curl http://localhost:3006/review-queue
```

**Resolve a flagged field (Scalar):**

```bash
curl -X POST http://localhost:3006/review-queue/1/resolve \
  -H "Content-Type: application/json" \
  -d '{"correctedValue": "2024-04-30"}'
```

**Resolve a flagged field (Array / Object):**

Structured fields like `lineItems` can be updated by sending either a raw JSON array or a stringified JSON array:

```bash
curl -X POST http://localhost:3006/review-queue/3/resolve \
  -H "Content-Type: application/json" \
  -d '{"correctedValue": [{"description": "Office Chairs", "quantity": 1, "unitPrice": 500, "lineTotal": 500}]}'
```

**Resolve a field with Super-User Override:**

If a source document is internally contradictory and cannot be resolved mathematically, use `bypassValidation: true` to skip the validator pass and complete it immediately:

```bash
curl -X POST http://localhost:3006/review-queue/3/resolve \
  -H "Content-Type: application/json" \
  -d '{"correctedValue": "9000", "bypassValidation": true}'
```

**Run tests (no API key required):**

```bash
npm test
```

**Type-check without compiling:**

```bash
npm run typecheck
```

## Environment variables

| Variable               | Default                     | Description                              |
|------------------------|-----------------------------|------------------------------------------|
| `CEREBRAS_API_KEY`     | —                           | Required                                 |
| `EXTRACTION_MODEL`     | `gpt-oss-120b`              | Model used for classification + extraction |
| `VALIDATION_MODEL`     | `gpt-oss-120b`              | Model used for the validator pass        |
| `DATABASE_URL`         | `postgresql://...`          | Postgres connection string               |
| `CONFIDENCE_THRESHOLD` | `0.75`                      | Below this score a field goes to review  |
| `ENABLE_VALIDATOR_PASS`| `true`                      | Set to `false` to disable validator pass |
| `PORT`                 | `3006`                      | Express port                             |

## Adding a new document type

1. Add a Zod schema to `src/schemas.ts`
2. Add a prompt + schema entry to `EXTRACTORS` in `src/agents/extractor.ts`
3. Add the new type to the `DocumentType` enum in `src/schemas.ts`
4. Add a test case to `tests/graph.test.ts`

That's it — the graph, validator, and API require no changes.
