/**
 * Tests run the graph with all agent calls mocked — no API key or network
 * access required. This is the CI test suite.
 *
 * A separate smaller suite of "live" tests (not included here) would hit the
 * real API against a handful of golden documents to catch prompt regressions.
 */

import { describe, expect, test, afterEach, jest } from "@jest/globals";

// Provide a fake key before any modules initialize the OpenAI client
process.env.CEREBRAS_API_KEY = "fake-test-key";

import { runPipeline } from "../src/graph";
import * as classifierModule from "../src/agents/classifier";
import * as extractorModule from "../src/agents/extractor";
import * as validatorModule from "../src/agents/validator";
import { FieldConfidence, InvoiceData } from "../src/schemas";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_INVOICE_TEXT = `
INVOICE #INV-2024-001
From: Acme Supplies Co.
Date: 2024-03-15
Due: 2024-04-14

Item         Qty  Unit Price  Total
Widgets       10     $5.00    $50.00
Gadgets        2    $25.00    $50.00

Subtotal: $100.00
Tax: $8.00
Total: $108.00
`;

function fakeInvoiceData(): Record<string, unknown> {
  const data: InvoiceData = {
    invoiceNumber: "INV-2024-001",
    vendorName: "Acme Supplies Co.",
    invoiceDate: "2024-03-15",
    dueDate: "2024-04-14",
    lineItems: [
      { description: "Widgets", quantity: 10, unitPrice: 5.0, lineTotal: 50.0 },
      { description: "Gadgets", quantity: 2, unitPrice: 25.0, lineTotal: 50.0 },
    ],
    subtotal: 100.0,
    tax: 8.0,
    total: 108.0,
    currency: "USD",
  };
  return data as Record<string, unknown>;
}

function highConfidenceScores(
  data: Record<string, unknown>
): FieldConfidence[] {
  return Object.keys(data).map((field) => ({
    field,
    score: 0.95,
    reason: "clearly stated in the document",
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPipeline", () => {
  afterEach(() => { jest.restoreAllMocks(); });

  test("high-confidence invoice completes without review", async () => {
    jest.spyOn(classifierModule, "classifyDocument").mockResolvedValue({
      documentType: "invoice",
      reason: "has invoice number and line items",
    });
    jest
      .spyOn(extractorModule, "extractDocument")
      .mockResolvedValue(fakeInvoiceData());
    jest
      .spyOn(validatorModule, "validateExtraction")
      .mockResolvedValue(highConfidenceScores(fakeInvoiceData()));

    const state = await runPipeline("doc-1", SAMPLE_INVOICE_TEXT);

    expect(state.status).toBe("completed");
    expect(state.documentType).toBe("invoice");
    expect(state.extraction?.data.invoiceNumber).toBe("INV-2024-001");
  });

  test("single low-confidence field routes document to pending_review", async () => {
    jest.spyOn(classifierModule, "classifyDocument").mockResolvedValue({
      documentType: "invoice",
      reason: "has invoice number and line items",
    });
    jest
      .spyOn(extractorModule, "extractDocument")
      .mockResolvedValue(fakeInvoiceData());

    const scores = highConfidenceScores(fakeInvoiceData()).map((fc) =>
      fc.field === "dueDate"
        ? { ...fc, score: 0.4, reason: "date format ambiguous" }
        : fc
    );
    jest
      .spyOn(validatorModule, "validateExtraction")
      .mockResolvedValue(scores);

    const state = await runPipeline("doc-2", SAMPLE_INVOICE_TEXT);

    expect(state.status).toBe("pending_review");
    const lowConf = (state.extraction?.fieldConfidence ?? []).filter(
      (fc) => fc.score < 0.75
    );
    expect(lowConf).toHaveLength(1);
    expect(lowConf[0].field).toBe("dueDate");
  });

  test("unknown document type skips extraction and goes to pending_review", async () => {
    jest.spyOn(classifierModule, "classifyDocument").mockResolvedValue({
      documentType: "unknown",
      reason: "looks like a personal letter",
    });

    const state = await runPipeline(
      "doc-3",
      "Dear friend, it has been a while..."
    );

    expect(state.status).toBe("pending_review");
    expect(state.extraction).toBeNull();
    expect(state.error).toMatch(/unrecognised document type/);
  });

  test("extraction failure marks document as failed without crashing", async () => {
    jest.spyOn(classifierModule, "classifyDocument").mockResolvedValue({
      documentType: "invoice",
      reason: "has invoice number",
    });
    jest
      .spyOn(extractorModule, "extractDocument")
      .mockRejectedValue(new Error("All retries exhausted"));

    const state = await runPipeline("doc-4", SAMPLE_INVOICE_TEXT);

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/extraction failed/);
    expect(state.extraction).toBeNull();
  });
});
