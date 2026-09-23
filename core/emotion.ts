import type { ChatEmotionConfig } from "../types";

function normalizeName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export class EmotionManager {
  constructor(
    private readonly store: (userId: string, emotion: string) => void,
  ) {}

  available(config: ChatEmotionConfig | null): string[] {
    const names = Object.keys(config?.emotions ?? {})
      .map(normalizeName)
      .filter(Boolean);
    return Array.from(new Set(["default", ...names]));
  }

  defaultEmotion(config: ChatEmotionConfig | null): string {
    const available = this.available(config);
    const candidate = normalizeName(config?.defaultEmotion);
    return available.includes(candidate) ? candidate : "default";
  }

  resolve(stored: unknown, config: ChatEmotionConfig | null): string {
    const available = this.available(config);
    const candidate = normalizeName(stored);
    if (candidate && available.includes(candidate)) return candidate;
    return this.defaultEmotion(config);
  }

  getCurrent(stored: string, config: ChatEmotionConfig | null): string {
    return this.resolve(stored, config);
  }

  setEmotion(
    userId: string,
    emotion: unknown,
    config: ChatEmotionConfig | null,
  ): string {
    const next = this.resolve(emotion, config);
    this.store(userId, next);
    return next;
  }
}
