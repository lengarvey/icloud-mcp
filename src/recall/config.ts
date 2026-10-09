// Semantic mail indexing is an explicit deployment opt-in. Missing, malformed,
// or truthy-looking values must never enable copying mail to Workers AI.
import { env } from "cloudflare:workers";

export function recallEnabled(config: { RECALL_ENABLED?: string } = env): boolean {
  return config.RECALL_ENABLED === "true";
}
