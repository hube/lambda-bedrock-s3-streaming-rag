import type { EnvironmentConfig } from "./types";
import dev from "./dev";
import alpha from "./alpha";
import prod from "./prod";

const configs: Record<string, EnvironmentConfig> = { dev, alpha, prod };

export function getEnvironmentConfig(name: string): EnvironmentConfig {
  const cfg = configs[name];
  if (!cfg) {
    throw new Error(
      `Unknown environment "${name}". Valid environments: ${Object.keys(configs).join(", ")}`,
    );
  }
  return cfg;
}

export { documentVectorizationPipelineEventBridgeEventSourceFor } from "./document-vectorization-pipeline-event-source";
