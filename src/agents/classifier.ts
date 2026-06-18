import { z } from "zod";
import { callWithSchema, JSON_OUTPUT_INSTRUCTION } from "./base";
import { config } from "../config";
import { DocumentType } from "../schemas";

const ClassificationResult = z.object({
  documentType: DocumentType,
  reason: z.string(),
});
export type ClassificationResult = z.infer<typeof ClassificationResult>;

const CLASSIFIER_SYSTEM_PROMPT = `You classify business documents into one of:
invoice, contract, receipt, unknown.

${JSON_OUTPUT_INSTRUCTION}

Schema: {"documentType": "invoice" | "contract" | "receipt" | "unknown", "reason": "<one short sentence>"}

Guidelines:
- "invoice": a bill requesting payment, has an invoice number and line items.
- "receipt": proof of a completed payment, usually from a retail/restaurant transaction.
- "contract": a legal agreement between parties with obligations and dates.
- "unknown": anything that doesn't clearly fit, or if you're unsure.
When unsure, prefer "unknown" — a misclassification sends the document to the
wrong extractor and produces worse results than flagging it.`;

export async function classifyDocument(
  rawText: string
): Promise<ClassificationResult> {
  // Truncate — classification only needs the first portion of the document,
  // and keeping this call cheap matters before the more expensive extraction.
  const excerpt = rawText.slice(0, 3000);

  return callWithSchema({
    model: config.extractionModel,
    systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
    userMessage: `Document text:\n\n${excerpt}`,
    schema: ClassificationResult,
    maxTokens: 200,
  });
}
