/**
 * LangGraph orchestration (TypeScript).
 *
 * Graph nodes:  classify → extract → validate → finalize
 *
 * classify and extract can fail — both write status:"failed" and the graph
 * routes straight to END rather than crashing the request.
 * finalize is where the confidence threshold decides between "completed"
 * and "pending_review".
 *
 * The retry-loop extension point (re-run extraction using validator
 * feedback in the prompt) is sketched in shouldRetryExtraction but not
 * wired in by default. Flip ENABLE_RETRY_LOOP to true to enable it.
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { classifyDocument } from "./agents/classifier";
import { extractDocument } from "./agents/extractor";
import { validateExtraction } from "./agents/validator";
import {
  PipelineState,
  ExtractionResult,
  lowConfidenceFields,
} from "./schemas";
import { config } from "./config";

const ENABLE_RETRY_LOOP = false;

// ---------------------------------------------------------------------------
// Node functions
// ---------------------------------------------------------------------------

async function classifyNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  const result = await classifyDocument(state.rawText);
  return { documentType: result.documentType };
}

async function extractNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  if (state.documentType === "unknown") {
    return { status: "pending_review", error: "unrecognised document type" };
  }

  try {
    const data = await extractDocument(state.documentType, state.rawText);
    const extraction: ExtractionResult = {
      documentType: state.documentType,
      data,
      fieldConfidence: [],
    };
    return { extraction };
  } catch (err) {
    return {
      status: "failed",
      error: `extraction failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function validateNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  if (!state.extraction) return {};

  const fieldConfidence = await validateExtraction(
    state.rawText,
    state.extraction.data
  );

  return {
    extraction: { ...state.extraction, fieldConfidence },
  };
}

async function finalizeNode(
  state: PipelineState
): Promise<Partial<PipelineState>> {
  if (state.status === "failed" || state.status === "pending_review") return {};
  if (!state.extraction) return { status: "failed", error: "no extraction result" };

  const lowConf = lowConfidenceFields(state.extraction, config.confidenceThreshold);
  return { status: lowConf.length > 0 ? "pending_review" : "completed" };
}

// ---------------------------------------------------------------------------
// Conditional edge for the (disabled) retry loop
// ---------------------------------------------------------------------------

function shouldRetryExtraction(state: PipelineState): string {
  if (!ENABLE_RETRY_LOOP || !state.extraction) return "finalize";
  const lowConf = lowConfidenceFields(state.extraction, config.confidenceThreshold);
  return lowConf.length > 0 ? "extract" : "finalize";
}

// ---------------------------------------------------------------------------
// Graph definition
// ---------------------------------------------------------------------------

// LangGraph requires the state to be annotated so it knows how to merge
// partial updates returned from each node.
const graphConfig = {
  channels: {
    documentId: { value: (a: string, b?: string) => b ?? a },
    rawText: { value: (a: string, b?: string) => b ?? a },
    documentType: {
      value: (
        a: PipelineState["documentType"],
        b?: PipelineState["documentType"]
      ) => b ?? a,
      default: () => "unknown" as const,
    },
    extraction: {
      value: (
        a: PipelineState["extraction"],
        b?: PipelineState["extraction"]
      ) => b ?? a,
      default: () => null,
    },
    status: {
      value: (
        a: PipelineState["status"],
        b?: PipelineState["status"]
      ) => b ?? a,
      default: () => "processing" as const,
    },
    error: {
      value: (a: PipelineState["error"], b?: PipelineState["error"]) => b ?? a,
      default: () => null,
    },
  },
};

function buildGraph() {
  const graph = new StateGraph<PipelineState>(graphConfig)
    .addNode("classify", classifyNode)
    .addNode("extract", extractNode)
    .addNode("validate", validateNode)
    .addNode("finalize", finalizeNode);

  graph.addEdge(START, "classify");
  graph.addEdge("classify", "extract");
  graph.addEdge("extract", "validate");

  if (ENABLE_RETRY_LOOP) {
    graph.addConditionalEdges("validate", shouldRetryExtraction, {
      extract: "extract",
      finalize: "finalize",
    });
  } else {
    graph.addEdge("validate", "finalize");
  }

  graph.addEdge("finalize", END);

  return graph.compile();
}

const pipeline = buildGraph();

export async function runPipeline(
  documentId: string,
  rawText: string
): Promise<PipelineState> {
  const initialState: PipelineState = {
    documentId,
    rawText,
    documentType: "unknown",
    extraction: null,
    status: "processing",
    error: null,
  };

  const result = await pipeline.invoke(initialState);
  return result as PipelineState;
}
