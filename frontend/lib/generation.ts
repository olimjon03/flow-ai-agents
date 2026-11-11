export const MAX_BRIEF_LENGTH = 1000;

export type DraftFormat = "post" | "video";
export type DraftMode = "sample" | "openai";
export type DraftRequest = { brief: string; format: DraftFormat };
export type DraftResponse = { draft: string; mode: DraftMode };

export function validateDraftRequest(value: unknown): DraftRequest | string {
  if (typeof value !== "object" || value === null) return "Enter a content brief.";

  const { brief, format } = value as Record<string, unknown>;
  if (typeof brief !== "string" || !brief.trim()) return "Enter a content brief.";
  if (brief.length > MAX_BRIEF_LENGTH) return "Keep the brief within 1,000 characters.";
  if (format !== "post" && format !== "video") return "Choose a content format.";

  return { brief: brief.trim(), format };
}

export function isDraftResponse(value: unknown): value is DraftResponse {
  if (typeof value !== "object" || value === null) return false;

  const { draft, mode } = value as Record<string, unknown>;
  return typeof draft === "string" && !!draft.trim() && (mode === "sample" || mode === "openai");
}
