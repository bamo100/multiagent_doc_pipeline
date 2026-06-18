/**
 * Validator agent.
 *
 * Runs a second model pass over the extracted data and the source text,
 * producing a per-field confidence score and reasoning (ARCHITECTURE.md,
 * decisions 3 and 4). Intentionally a separate call from extraction so it
 * can use a cheaper model and be toggled off via config.enableValidatorPass.
 */

import { z } from "zod";
import { callWithSchema, JSON_OUTPUT_INSTRUCTION } from "./base";
import { config } from "../config";
import { FieldConfidence } from "../schemas";

const ValidatorFieldConfidence = z.object({
  field: z.string(),
  calculation_check: z.string(),
  score: z.number().min(0).max(1),
  reason: z.string(),
});

const ValidationResponse = z.object({
  fields: z.array(ValidatorFieldConfidence),
});

const VALIDATOR_SYSTEM_PROMPT = `You are a meticulous auditor checking whether
extracted data correctly reflects a source document.

${JSON_OUTPUT_INSTRUCTION}

Schema: {"fields": [{"field": string, "calculation_check": "<step-by-step verification>", "score": number between 0 and 1, "reason": "<short sentence>"}]}

For EVERY top-level field in the extracted data, return one entry.
- BEFORE scoring, use "calculation_check" to explicitly write out the math: 1) Sum the line items to verify the subtotal. 2) Add subtotal + tax to verify the total.
- score 1.0: value is clearly stated in the source AND mathematically consistent.
- score 0.5–0.8: value required inference, or the source is ambiguous.
- score < 0.5: value looks wrong, fabricated, or mathematically inconsistent.
  CRITICAL: If the math fails (e.g. line items don't sum to subtotal, or subtotal+tax != total), you MUST score ALL involved fields (e.g., subtotal, total, and lineItems) < 0.5. Do not just flag one field.

Be skeptical. Your job is to catch errors the extractor missed, not to rubber-stamp its output.`;

export async function validateExtraction(
  rawText: string,
  extractedData: Record<string, unknown>
): Promise<FieldConfidence[]> {
  if (!config.enableValidatorPass) {
    // Validator pass disabled: assume full confidence. This roughly halves
    // per-document API cost but removes the cross-check for plausible-but-wrong
    // values. See ARCHITECTURE.md decision 4.
    return Object.keys(extractedData).map((field) => ({
      field,
      score: 1.0,
      reason: "validator pass disabled",
    }));
  }

  const userMessage =
    `Source document:\n\n${rawText}\n\n` +
    `Extracted data:\n\n${JSON.stringify(extractedData, null, 2)}`;

  const result = await callWithSchema({
    model: config.validationModel,
    systemPrompt: VALIDATOR_SYSTEM_PROMPT,
    userMessage,
    schema: ValidationResponse,
    maxTokens: 2048,
  });

  return result.fields.map(f => ({
    field: f.field,
    score: f.score,
    reason: f.reason,
  }));
}
