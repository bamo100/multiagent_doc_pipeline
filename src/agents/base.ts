/**
 * Shared infrastructure every agent uses to call the model.
 *
 * Centralising this is the seam where you'd add cost tracking,
 * tracing, and prompt versioning — exactly the surface the observability
 * dashboard project instruments. For now it logs token usage to the
 * console. See ARCHITECTURE.md "known limitations."
 */

// import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { config } from "../config";

// const client = new Anthropic({ apiKey: config.anthropicApiKey });
const client = new OpenAI({
  apiKey: process.env.CEREBRAS_API_KEY!,
  baseURL: "https://api.cerebras.ai/v1",
});


export class ExtractionFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionFailedError";
  }
}

export const JSON_OUTPUT_INSTRUCTION =
  "Respond with ONLY valid JSON matching the schema described. " +
  "No prose, no markdown fences, no explanation before or after the JSON object.";

function stripCodeFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) t = t.slice(t.indexOf("\n") + 1);
  if (t.endsWith("```")) t = t.slice(0, t.lastIndexOf("```"));
  return t.trim();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call the model and parse the response into a Zod schema.
 * Retries up to 3 times on JSON parse or validation failure,
 * with exponential backoff — the "constraint tightening" retry pattern.
 */
export async function callWithSchema<T>(options: {
  model: string;
  systemPrompt: string;
  userMessage: string;
  schema: z.ZodSchema<T>;
  maxTokens?: number;
}): Promise<T> {
  const { model, systemPrompt, userMessage, schema, maxTokens = 2048 } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
      });

      console.log(
        `[agent] model=${model} attempt=${attempt}`,
        `input_tokens=${response.usage?.prompt_tokens}`,
        `output_tokens=${response.usage?.completion_tokens}`
      );

      const rawText = response.choices[0]?.message?.content || "";

      const cleaned = stripCodeFences(rawText);
      const parsed = JSON.parse(cleaned) as unknown;
      return schema.parse(parsed);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[agent] attempt ${attempt} failed:`, lastError.message);
      if (attempt < 3) await sleep(2 ** attempt * 500);
    }
  }

  throw new ExtractionFailedError(
    `All retries exhausted. Last error: ${lastError?.message}`
  );
}
