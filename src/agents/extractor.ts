/**
 * Per-document-type extractor agents.
 *
 * Each extractor has its own prompt and Zod schema (ARCHITECTURE.md, decision 2).
 * Adding a new document type: add a schema to schemas.ts, write a prompt below,
 * register it in EXTRACTORS, and update the classifier's allowed types.
 */

import { z } from "zod";
import { callWithSchema, JSON_OUTPUT_INSTRUCTION } from "./base";
import { config } from "../config";
import {
  ContractData,
  DocumentType,
  InvoiceData,
  ReceiptData,
} from "../schemas";

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const INVOICE_SYSTEM_PROMPT = `You extract structured data from invoices.

${JSON_OUTPUT_INSTRUCTION}

Schema:
{
  "invoiceNumber": string,
  "vendorName": string,
  "invoiceDate": "YYYY-MM-DD" | null,
  "dueDate": "YYYY-MM-DD" | null,
  "lineItems": [{"description": string, "quantity": number, "unitPrice": number, "lineTotal": number}],
  "subtotal": number,
  "tax": number,
  "total": number,
  "currency": string
}

Rules:
- If a field is not present in the document, use null for optional fields — never guess.
- "total" must be the final amount due, including tax.
- Infer currency from symbol ("$" -> "USD", "€" -> "EUR"). Default to "USD" if none indicated.`;

const CONTRACT_SYSTEM_PROMPT = `You extract structured data from contracts.

${JSON_OUTPUT_INSTRUCTION}

Schema:
{
  "contractTitle": string,
  "parties": [string],
  "effectiveDate": "YYYY-MM-DD" | null,
  "terminationDate": "YYYY-MM-DD" | null,
  "governingLaw": string | null,
  "keyObligations": [string],
  "totalValue": number | null,
  "currency": string
}

Rules:
- "parties" should list the full legal names of each party to the agreement.
- "keyObligations" should be 3–7 short summaries of main commitments — do not quote verbatim.
- If no monetary value is specified, set "totalValue" to null.`;

const RECEIPT_SYSTEM_PROMPT = `You extract structured data from receipts.

${JSON_OUTPUT_INSTRUCTION}

Schema:
{
  "merchantName": string,
  "transactionDate": "YYYY-MM-DD" | null,
  "items": [{"description": string, "quantity": number, "unitPrice": number, "lineTotal": number}],
  "total": number,
  "paymentMethod": string | null,
  "currency": string
}

Rules:
- "total" is the final amount charged, including tax and tip if shown.
- If individual items are not listed, return a single line item summarising the purchase.`;

// ---------------------------------------------------------------------------
// Registry — maps document type to (prompt, schema) pair
// ---------------------------------------------------------------------------

type ExtractorEntry = {
  systemPrompt: string;
  schema: z.ZodSchema;
};

const EXTRACTORS: Partial<Record<DocumentType, ExtractorEntry>> = {
  invoice: { systemPrompt: INVOICE_SYSTEM_PROMPT, schema: InvoiceData },
  contract: { systemPrompt: CONTRACT_SYSTEM_PROMPT, schema: ContractData },
  receipt: { systemPrompt: RECEIPT_SYSTEM_PROMPT, schema: ReceiptData },
};

export async function extractDocument(
  documentType: DocumentType,
  rawText: string
): Promise<Record<string, unknown>> {
  const entry = EXTRACTORS[documentType];
  if (!entry) {
    throw new Error(`No extractor registered for document type: ${documentType}`);
  }

  const result = await callWithSchema({
    model: config.extractionModel,
    systemPrompt: entry.systemPrompt,
    userMessage: `Document text:\n\n${rawText}`,
    schema: entry.schema,
    maxTokens: 4096,
  });

  return result as Record<string, unknown>;
}
