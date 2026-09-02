export interface EvaluationDimensionContractItem {
  name: string;
  priority?: "must" | "should";
}

/**
 * A multi-verdict judge declares the dimensions it emits inside its prompt.
 * Keeping this parser shared makes the authored plan and the runtime enforce the
 * same contract: every declared dimension is visible before a run and required
 * in the judge response afterwards.
 */
export function parseEvaluationDimensionContract(
  prompt: string,
): EvaluationDimensionContractItem[] {
  const raw = prompt.match(/<DimensionContract>([\s\S]*?)<\/DimensionContract>/)?.[1];
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const dimensions = value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) return [];
    const priority: EvaluationDimensionContractItem["priority"] =
      record.priority === "must" || record.priority === "should"
      ? record.priority
      : undefined;
    return [{ name, ...(priority ? { priority } : {}) }];
  });
  const unique = new Set(dimensions.map((item) => item.name));
  return unique.size === dimensions.length ? dimensions : [];
}
