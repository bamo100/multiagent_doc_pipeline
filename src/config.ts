import "dotenv/config";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export const config = {
  // anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  anthropicApiKey: requireEnv("CEREBRAS_API_KEY"),

  extractionModel: process.env.EXTRACTION_MODEL ?? "claude-sonnet-4-6",
  validationModel: process.env.VALIDATION_MODEL ?? "claude-haiku-4-5-20251001",

  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/docintel",

  // Below this score (0–1), a field is flagged for human review.
  confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD ?? "0.75"),

  // Toggle off to halve per-document cost — see ARCHITECTURE.md decision 4.
  enableValidatorPass: process.env.ENABLE_VALIDATOR_PASS !== "false",

  port: parseInt(process.env.PORT ?? "3000", 10),
} as const;
