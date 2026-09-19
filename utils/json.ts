export function extractJsonObject<T = unknown>(text: string): T | undefined {
  const match = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  return JSON.parse(match[0]) as T;
}
