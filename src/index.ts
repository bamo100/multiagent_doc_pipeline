import express, { Request, Response } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import pdfParse from "pdf-parse";
import * as fs from "fs";
import * as path from "path";
import { pool, initDb } from "./db";
import { runPipeline } from "./graph";
import { lowConfidenceFields, InvoiceData, ContractData, ReceiptData } from "./schemas";
import { z } from "zod";
import { validateExtraction } from "./agents/validator";
import { config } from "./config";

const SCHEMAS: Record<string, z.ZodObject<any>> = {
  invoice: InvoiceData as any,
  contract: ContractData as any,
  receipt: ReceiptData as any,
};

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const upload = multer({ storage: multer.memoryStorage() });

// ---------------------------------------------------------------------------
// POST /documents — upload and process a document
// ---------------------------------------------------------------------------

app.post(
  "/documents",
  upload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    let rawText: string;
    try {
      if (req.file.originalname.toLowerCase().endsWith(".pdf")) {
        const parsed = await pdfParse(req.file.buffer);
        rawText = parsed.text;
      } else {
        rawText = req.file.buffer.toString("utf-8");
      }
    } catch {
      res.status(422).json({ error: "Could not extract text from file" });
      return;
    }

    if (!rawText.trim()) {
      res.status(422).json({ error: "File contains no extractable text" });
      return;
    }

    const documentId = randomUUID();
    const state = await runPipeline(documentId, rawText);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO documents (id, filename, document_type, status, raw_text)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          documentId,
          req.file.originalname,
          state.documentType,
          state.status,
          rawText,
        ]
      );

      if (state.extraction) {
        await client.query(
          `INSERT INTO extractions (document_id, data, field_confidence)
           VALUES ($1, $2, $3)`,
          [
            documentId,
            JSON.stringify(state.extraction.data),
            JSON.stringify(state.extraction.fieldConfidence),
          ]
        );

        if (state.status === "pending_review") {
          const lowConf = lowConfidenceFields(
            state.extraction,
            config.confidenceThreshold
          );
          for (const fc of lowConf) {
            await client.query(
              `INSERT INTO review_items
                 (document_id, field_name, extracted_value, confidence, reason)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                documentId,
                fc.field,
                typeof state.extraction.data[fc.field] === "object"
                  ? JSON.stringify(state.extraction.data[fc.field])
                  : String(state.extraction.data[fc.field] ?? ""),
                fc.score,
                fc.reason,
              ]
            );
          }
        }
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const responsePayload = {
      documentId,
      documentType: state.documentType,
      status: state.status,
      error: state.error,
      extraction: state.extraction?.data ?? null,
      fieldConfidence: state.extraction?.fieldConfidence ?? [],
    };

    try {
      const resultsDir = path.join(process.cwd(), "..", "results");
      if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(resultsDir, `${documentId}.json`),
        JSON.stringify(responsePayload, null, 2)
      );
    } catch (e) {
      console.error("Failed to write to results folder:", e);
    }

    const message = state.status === "pending_review" 
      ? "Document processed, but some fields require human review."
      : "Document processed successfully.";

    res.status(201).json({
      message,
      documentId,
      status: state.status,
      resultSavedAt: `results/${documentId}.json`
    });
  }
);

// ---------------------------------------------------------------------------
// GET /documents — list all processed/pending documents
// ---------------------------------------------------------------------------

app.get("/documents", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.filename, d.document_type, d.status, d.created_at
       FROM documents d
       ORDER BY d.created_at DESC
       LIMIT 50`
    );
    res.json(
      rows.map((row) => ({
        documentId: row.id,
        filename: row.filename,
        documentType: row.document_type,
        status: row.status,
        createdAt: row.created_at,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /documents/:id — fetch document and extraction result
// ---------------------------------------------------------------------------

app.get("/documents/:id", async (req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.filename, d.document_type, d.status,
            e.data, e.field_confidence
     FROM documents d
     LEFT JOIN extractions e ON e.document_id = d.id
     WHERE d.id = $1`,
    [req.params.id]
  );

  if (rows.length === 0) {
    res.status(404).json({ error: "Document not found" });
    return;
  }

  const row = rows[0];
  res.json({
    documentId: row.id,
    filename: row.filename,
    documentType: row.document_type,
    status: row.status,
    extraction: row.data ?? null,
    fieldConfidence: row.field_confidence ?? [],
  });
});

// ---------------------------------------------------------------------------
// GET /review-queue — list unresolved review items with document details
// ---------------------------------------------------------------------------

app.get("/review-queue", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.document_id, r.field_name, r.extracted_value, r.confidence, r.reason,
              d.filename, d.document_type
       FROM review_items r
       JOIN documents d ON d.id = r.document_id
       WHERE r.resolved = FALSE
       ORDER BY r.created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /review-queue/:id/resolve — human submits a corrected value
// ---------------------------------------------------------------------------

async function runBackgroundValidation(
  documentId: string,
  docType: string,
  rawText: string
): Promise<void> {
  try {
    console.log(`[background-validator] Starting verification for doc=${documentId}`);
    // 1. Fetch the latest extraction data
    const { rows: extRows } = await pool.query(
      `SELECT data FROM extractions WHERE document_id = $1`,
      [documentId]
    );
    if (extRows.length === 0) {
      console.warn(`[background-validator] No extraction found for doc=${documentId}`);
      return;
    }
    const finalData = extRows[0].data;

    // 2. Run the Validator Agent
    const newFieldConfidence = await validateExtraction(rawText, finalData);

    // 3. Start a new transaction to update DB
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Update the confidence scores in DB
      await client.query(
        `UPDATE extractions
         SET field_confidence = $1
         WHERE document_id = $2`,
        [JSON.stringify(newFieldConfidence), documentId]
      );

      // Low-confidence score less than 0.5 for human edits, as requested.
      const RE_VALIDATION_THRESHOLD = 0.5;
      const lowConf = newFieldConfidence.filter(
        (fc) => fc.score < RE_VALIDATION_THRESHOLD
      );

      let finalStatus = "completed";
      if (lowConf.length > 0) {
        finalStatus = "pending_review";
        // Re-flag fields that failed validation
        for (const fc of lowConf) {
          const { rows: existingItem } = await client.query(
            `SELECT id FROM review_items WHERE document_id = $1 AND field_name = $2`,
            [documentId, fc.field]
          );

          if (existingItem.length > 0) {
            await client.query(
              `UPDATE review_items
               SET resolved = FALSE, confidence = $1, reason = $2, corrected_value = NULL
               WHERE id = $3`,
              [fc.score, fc.reason, existingItem[0].id]
            );
          } else {
            await client.query(
              `INSERT INTO review_items
                 (document_id, field_name, extracted_value, confidence, reason)
               VALUES ($1, $2, $3, $4, $5)`,
              [
                documentId,
                fc.field,
                typeof finalData[fc.field] === "object"
                  ? JSON.stringify(finalData[fc.field])
                  : String(finalData[fc.field] ?? ""),
                fc.score,
                fc.reason,
              ]
            );
          }
        }
        console.log(
          `[background-validator] Validation failed for doc=${documentId}. ` +
          `Flagged fields: ${lowConf.map((f) => f.field).join(", ")}`
        );
      } else {
        console.log(`[background-validator] Validation passed for doc=${documentId}. Marking completed.`);
      }

      // Update the document status
      await client.query(
        `UPDATE documents SET status = $1 WHERE id = $2`,
        [finalStatus, documentId]
      );

      await client.query("COMMIT");

      // Write updated document status to results folder for local sync
      try {
        const resultsDir = path.join(process.cwd(), "..", "results");
        if (fs.existsSync(resultsDir)) {
          const resultFilePath = path.join(resultsDir, `${documentId}.json`);
          if (fs.existsSync(resultFilePath)) {
            const fileContent = JSON.parse(fs.readFileSync(resultFilePath, "utf8"));
            fileContent.status = finalStatus;
            fileContent.extraction = finalData;
            fileContent.fieldConfidence = newFieldConfidence;

            fs.writeFileSync(resultFilePath, JSON.stringify(fileContent, null, 2));
          }
        }
      } catch (e) {
        console.error("Failed to sync file results:", e);
      }
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`Background validation transaction failed for document ${documentId}:`, err);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`Background validation failed for document ${documentId}:`, err);
    // Fallback: update status back to pending_review so the document isn't stuck in validating_review
    try {
      await pool.query(
        `UPDATE documents SET status = 'pending_review' WHERE id = $1`,
        [documentId]
      );
    } catch (dbErr) {
      console.error("Failed to reset document status on validation error:", dbErr);
    }
  }
}

app.post(
  "/review-queue/:id/resolve",
  async (req: Request, res: Response) => {
    const itemId = parseInt(req.params.id as string, 10);
    const { correctedValue, bypassValidation } = req.body as {
      correctedValue: string;
      bypassValidation?: boolean;
    };

    if (correctedValue === undefined || correctedValue === null) {
      res.status(400).json({ error: "correctedValue is required" });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1. Get review item & document details
      const { rows: itemRows } = await client.query(
        `SELECT r.document_id, r.field_name, d.document_type, d.raw_text, e.data AS extraction_data
         FROM review_items r
         JOIN documents d ON d.id = r.document_id
         LEFT JOIN extractions e ON e.document_id = d.id
         WHERE r.id = $1 AND r.resolved = FALSE`,
        [itemId]
      );

      if (itemRows.length === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Unresolved review item not found" });
        return;
      }

      const {
        document_id: documentId,
        field_name: fieldName,
        document_type: docType,
        raw_text: rawText,
        extraction_data: existingData,
      } = itemRows[0];

      const schema = SCHEMAS[docType];
      let coercedValue: any = correctedValue;

      // Automatically parse JSON arrays/objects if passed as a string
      if (typeof correctedValue === "string") {
        const trimmed = correctedValue.trim();
        if (
          (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
          (trimmed.startsWith("{") && trimmed.endsWith("}"))
        ) {
          try {
            coercedValue = JSON.parse(trimmed);
          } catch (e) {
            // Keep original string if parsing fails
          }
        }
      }

      // 2. Perform Type Coercion & Schema Check if a schema exists
      if (schema) {
        const fieldSchema = schema.shape[fieldName];
        if (fieldSchema) {
          // Unwrap Nullable, Optional, and Default wraps to find the base type
          let currentDef = fieldSchema;
          while (
            currentDef &&
            (currentDef instanceof z.ZodNullable ||
              currentDef instanceof z.ZodOptional ||
              currentDef instanceof z.ZodDefault)
          ) {
            if (currentDef instanceof z.ZodNullable) currentDef = currentDef.unwrap();
            else if (currentDef instanceof z.ZodOptional) currentDef = currentDef.unwrap();
            else if (currentDef instanceof z.ZodDefault) currentDef = currentDef._def.innerType;
          }

          // Coerce to number if the target field is numeric
          if (currentDef instanceof z.ZodNumber) {
            const num = Number(coercedValue);
            if (isNaN(num)) {
              await client.query("ROLLBACK");
              res.status(400).json({ error: `Field '${fieldName}' must be a valid number` });
              return;
            }
            coercedValue = num;
          } else if (coercedValue === "null" || coercedValue === "") {
            coercedValue = null;
          }
        }

        // Test-validate the proposed merged state
        const proposedData = {
          ...existingData,
          [fieldName]: coercedValue,
        };

        const parseResult = schema.safeParse(proposedData);
        if (!parseResult.success) {
          await client.query("ROLLBACK");
          res.status(400).json({
            error: `Correction violates schema for field '${fieldName}'`,
            details: parseResult.error.errors,
          });
          return;
        }
      }

      // 3. Persist the corrected value
      await client.query(
        `UPDATE review_items
         SET resolved = TRUE, corrected_value = $1
         WHERE id = $2`,
        [
          typeof coercedValue === "object" && coercedValue !== null
            ? JSON.stringify(coercedValue)
            : String(coercedValue),
          itemId,
        ]
      );
      // console.log("Field Name:", fieldName)
      // console.log("Coerced Value:", JSON.stringify(coercedValue))
      // Apply correction to persisted extraction (using correct type)
      await client.query(
        `UPDATE extractions
         SET data = jsonb_set(data, $1, $2::jsonb)
         WHERE document_id = $3`,
        [`{${fieldName}}`, JSON.stringify(coercedValue), documentId]
      );

      // 4. Check if this is the final resolution
      const { rows: remaining } = await client.query(
        `SELECT COUNT(*) AS cnt FROM review_items
         WHERE document_id = $1 AND resolved = FALSE`,
        [documentId]
      );

      const remainingCount = parseInt((remaining[0] as { cnt: string }).cnt, 10);
      let status = "pending_review";
      let message = "Correction saved successfully.";

      if (remainingCount === 0) {
        if (bypassValidation === true) {
          // Super user override: Mark completed immediately
          await client.query(
            `UPDATE documents SET status = 'completed' WHERE id = $1`,
            [documentId]
          );
          status = "completed";
          message = "Document resolved and marked completed (validation bypassed).";
        } else {
          // Set to validating review to show it is undergoing validation
          await client.query(
            `UPDATE documents SET status = 'validating_review' WHERE id = $1`,
            [documentId]
          );
          status = "validating_review";
          message = "All corrections saved. Re-running validation in background.";
        }
      }

      await client.query("COMMIT");

      // Write updated document status to results folder for local sync (if completed synchronously)
      if (status === "completed") {
        try {
          const resultsDir = path.join(process.cwd(), "..", "results");
          if (fs.existsSync(resultsDir)) {
            const resultFilePath = path.join(resultsDir, `${documentId}.json`);
            if (fs.existsSync(resultFilePath)) {
              const fileContent = JSON.parse(fs.readFileSync(resultFilePath, "utf8"));
              fileContent.status = status;
              fileContent.extraction = {
                ...existingData,
                [fieldName]: coercedValue,
              };
              fs.writeFileSync(resultFilePath, JSON.stringify(fileContent, null, 2));
            }
          }
        } catch (e) {
          console.error("Failed to sync file results:", e);
        }
      }

      // Trigger background validation if needed
      if (status === "validating_review") {
        runBackgroundValidation(documentId, docType, rawText);
      }

      res.json({
        resolved: true,
        documentId,
        status,
        message,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  }
);

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export async function startServer(): Promise<void> {
  console.log("Start...")
  await initDb();
  console.log("DB started..")
  app.listen(config.port, () => {
    console.log(`Document Intelligence Pipeline running on port ${config.port}`);
  });
}

startServer();
