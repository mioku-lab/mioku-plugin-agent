import type { AgentSettingsConfig } from "../types";

export const CONTEXT_WINDOW_CHOICES = [
  { label: "128K", value: 128 * 1024 },
  { label: "256K", value: 256 * 1024 },
  { label: "512K", value: 512 * 1024 },
  { label: "1M", value: 1024 * 1024 },
  { label: "10M", value: 10 * 1024 * 1024 },
];

export const DEFAULT_CONTEXT_WINDOW = 512 * 1024;

export function compactionThresholdTokens(maxContextTokens: number): number {
  return Math.max(1, Math.floor(maxContextTokens * 0.9375));
}
