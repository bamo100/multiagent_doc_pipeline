/**
 * Zod schemas for the pipeline.
 *
 * Two kinds of schema live here:
 *
 * 1. Document schemas (InvoiceData, ContractData, ReceiptData) — what the
 *    extractor agents must return. Separate per document type on purpose
 *    (see ARCHITECTURE.md, decision 2).
 *
 * 2. Pipeline schemas (FieldConfidence, ExtractionResult, PipelineState) —
 *    the data that flows through the LangGraph state graph.
 *
 * Zod is used instead of plain TypeScript interfaces so every agent
 * response can be validated at runtime with the same schema objects the
 * type system already knows about — one source of truth.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const DocumentType = z.enum([
  "invoice",
  "contract",
  "receipt",
  "unknown",
]);
export type DocumentType = z.infer<typeof DocumentType>;

// ---------------------------------------------------------------------------
// Document-type schemas
// ---------------------------------------------------------------------------

export const LineItem = z.object({
  description: z.string(),
  quantity: z.number(),
  unitPrice: z.number(),
  lineTotal: z.number(),
});
export type LineItem = z.infer<typeof LineItem>;

export const InvoiceData = z.object({
  invoiceNumber: z.string(),
  vendorName: z.string(),
  invoiceDate: z.string().nullable(),   // "YYYY-MM-DD" or null
  dueDate: z.string().nullable(),
  lineItems: z.array(LineItem).default([]),
  subtotal: z.number(),
  tax: z.number().default(0),
  total: z.number(),
  currency: z.string().default("USD"),
});
export type InvoiceData = z.infer<typeof InvoiceData>;

export const ContractData = z.object({
  contractTitle: z.string(),
  parties: z.array(z.string()),
  effectiveDate: z.string().nullable(),
  terminationDate: z.string().nullable(),
  governingLaw: z.string().nullable(),
  keyObligations: z.array(z.string()).default([]),
  totalValue: z.number().nullable(),
  currency: z.string().default("USD"),
});
export type ContractData = z.infer<typeof ContractData>;

export const ReceiptData = z.object({
  merchantName: z.string(),
  transactionDate: z.string().nullable(),
  items: z.array(LineItem).default([]),
  total: z.number(),
  paymentMethod: z.string().nullable(),
  currency: z.string().default("USD"),
});
export type ReceiptData = z.infer<typeof ReceiptData>;

// ---------------------------------------------------------------------------
// Pipeline state schemas
// ---------------------------------------------------------------------------

export const FieldConfidence = z.object({
  field: z.string(),
  score: z.number().min(0).max(1),
  reason: z.string(),
});
export type FieldConfidence = z.infer<typeof FieldConfidence>;

export const ExtractionResult = z.object({
  documentType: DocumentType,
  // Using Record<string, unknown> because the shape varies per document type.
  data: z.record(z.unknown()),
  fieldConfidence: z.array(FieldConfidence).default([]),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

export const PipelineStatus = z.enum([
  "processing",
  "completed",
  "pending_review",
  "validating_review",
  "failed",
]);
export type PipelineStatus = z.infer<typeof PipelineStatus>;

export interface PipelineState {
  documentId: string;
  rawText: string;
  documentType: DocumentType;
  extraction: ExtractionResult | null;
  status: PipelineStatus;
  error: string | null;
}

export function lowConfidenceFields(
  result: ExtractionResult,
  threshold: number
): FieldConfidence[] {
  return result.fieldConfidence.filter((fc) => fc.score < threshold);
}
