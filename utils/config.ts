function isConfigObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeAgentConfig<T extends object>(
  defaults: T,
  overrides: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults as Record<string, unknown>)) {
    if (isConfigObject(value)) {
      result[key] = mergeAgentConfig(value, {});
    } else if (Array.isArray(value)) {
      result[key] = [...value];
    } else {
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined || value === null) continue;
    if (isConfigObject(value)) {
      const baseValue = isConfigObject(result[key]) ? result[key] : {};
      result[key] = mergeAgentConfig(baseValue, value);
    } else if (Array.isArray(value)) {
      result[key] = [...value];
    } else {
      result[key] = value;
    }
  }
  return result as T;
}
