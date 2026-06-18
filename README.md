# Document Intelligence Pipeline (TypeScript)

A multi-agent pipeline that ingests mixed business documents (invoices,
contracts, receipts), routes them through specialised agents, reconciles
outputs, and writes validated structured data to PostgreSQL — escalating
to a human reviewer whenever confidence is low.

## Stack

- **Orchestration:** `@langchain/langgraph` (TypeScript SDK)
- **Model access:** `@anthropic-ai/sdk`
- **Schema validation:** Zod (runtime + compile-time, one source of truth)
- **API layer:** Express
- **File upload:** Multer (in-memory, streams straight to pdf-parse)
- **Persistence:** PostgreSQL via `pg`

## Project layout

```
src/
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

See `ARCHITECTURE.md` for the five key tradeoffs: why LangGraph instead
of a fixed chain, why per-type extractors, why per-field confidence, why
validation is a second model call, and why review is async.

## Getting started

```bash
npm install
cp .env.example .env       # add ANTHROPIC_API_KEY and DATABASE_URL
npm run dev                # ts-node-dev with hot reload
```

**Upload a document:**

```bash
curl -X POST http://localhost:3000/documents \
  -F "file=@samples/invoice_001.pdf"
```

**Check review queue:**

```bash
curl http://localhost:3000/review-queue
```

**Resolve a flagged field:**

```bash
curl -X POST http://localhost:3000/review-queue/1/resolve \
  -H "Content-Type: application/json" \
  -d '{"correctedValue": "2024-04-30"}'
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
| `ANTHROPIC_API_KEY`    | —                           | Required                                 |
| `EXTRACTION_MODEL`     | `claude-sonnet-4-6`        | Model used for classification + extraction |
| `VALIDATION_MODEL`     | `claude-haiku-4-5-20251001` | Cheaper model for the validator pass     |
| `DATABASE_URL`         | `postgresql://...`          | Postgres connection string               |
| `CONFIDENCE_THRESHOLD` | `0.75`                      | Below this score a field goes to review  |
| `ENABLE_VALIDATOR_PASS`| `true`                      | Set to `false` to halve cost (see ARCHITECTURE.md) |
| `PORT`                 | `3000`                      | Express port                             |

## Adding a new document type

1. Add a Zod schema to `src/schemas.ts`
2. Add a prompt + schema entry to `EXTRACTORS` in `src/agents/extractor.ts`
3. Add the new type to the `DocumentType` enum in `src/schemas.ts`
4. Add a test case to `tests/graph.test.ts`

That's it — the graph, validator, and API require no changes.
