export const CHAT_MAX_CHARS = 160;
export const CHAT_HISTORY_LIMIT = 50;
export const CHAT_COOLDOWN_MS = 1000;

/** A single plain-text line, counted in Unicode code points. */
export function chatText(value) {
  if (typeof value !== 'string' || value.length > CHAT_MAX_CHARS * 2 || /\p{Cc}/u.test(value)) return null;
  const text = value.trim();
  return text && [...text].length <= CHAT_MAX_CHARS ? text : null;
}
