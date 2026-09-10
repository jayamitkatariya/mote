export const PIN_PREFIX = "pin-";

export function pinLabel(noteId: string): string {
  return `${PIN_PREFIX}${noteId}`;
}

export function noteIdFromLabel(label: string): string | null {
  if (!label.startsWith(PIN_PREFIX)) return null;
  const id = label.slice(PIN_PREFIX.length);
  return id.length > 0 ? id : null;
}

export function togglePinId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}
