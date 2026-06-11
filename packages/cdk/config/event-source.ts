export function eventSourceFor(environmentName: string): string {
  return `DocumentVectorizationPipeline.${environmentName}`;
}
