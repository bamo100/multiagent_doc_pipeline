import express, { Request, Response } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import pdfParse from "pdf-parse";
import * as fs from "fs";
import * as path from "path";
import { pool, initDb } from "./db";
import { runPipeline } from "./graph";
import { lowConfidenceFields } from "./schemas";
import { config } from "./config";

const app = express();
app.use(express.json());

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
                String(state.extraction.data[fc.field] ?? ""),
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
// GET /review-queue — list unresolved review items
// ---------------------------------------------------------------------------

app.get("/review-queue", async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id, document_id, field_name, extracted_value, confidence, reason
     FROM review_items
     WHERE resolved = FALSE
     ORDER BY created_at ASC`
  );
  res.json(rows);
});

// ---------------------------------------------------------------------------
// POST /review-queue/:id/resolve — human submits a corrected value
// ---------------------------------------------------------------------------

app.post(
  "/review-queue/:id/resolve",
  async (req: Request, res: Response) => {
    const itemId = parseInt(req.params.id as string, 10);
    const { correctedValue } = req.body as { correctedValue: string };

    if (!correctedValue) {
      res.status(400).json({ error: "correctedValue is required" });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const { rows } = await client.query(
        `UPDATE review_items
         SET resolved = TRUE, corrected_value = $1
         WHERE id = $2
         RETURNING document_id, field_name`,
        [correctedValue, itemId]
      );

      if (rows.length === 0) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Review item not found" });
        return;
      }

      const { document_id: documentId, field_name: fieldName } = rows[0] as {
        document_id: string;
        field_name: string;
      };

      // Apply correction to persisted extraction.
      await client.query(
        `UPDATE extractions
         SET data = jsonb_set(data, $1, $2::jsonb)
         WHERE document_id = $3`,
        [`{${fieldName}}`, JSON.stringify(correctedValue), documentId]
      );

      // If no more unresolved items, mark the document completed.
      const { rows: remaining } = await client.query(
        `SELECT COUNT(*) AS cnt FROM review_items
         WHERE document_id = $1 AND resolved = FALSE`,
        [documentId]
      );

      if (parseInt((remaining[0] as { cnt: string }).cnt, 10) === 0) {
        await client.query(
          `UPDATE documents SET status = 'completed' WHERE id = $1`,
          [documentId]
        );
      }

      await client.query("COMMIT");
      res.json({ resolved: true, documentId });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
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
