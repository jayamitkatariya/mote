import type { Note } from "./types";

export type Range = [number, number];

export interface Match {
  note: Note;
  score: number;
  titleRanges: Range[];
  snippet: string;
  snippetRanges: Range[];
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function fuzzyMatch(
  text: string,
  query: string,
): { score: number; ranges: Range[] } | null {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return { score: 0, ranges: [] };
  const haystack = text.toLowerCase();
  let cursor = 0;
  let score = 0;
  let consecutive = 0;
  const ranges: Range[] = [];
  let runStart = -1;
  let runEnd = -1;

  for (const character of needle) {
    let found = -1;
    while (cursor < haystack.length) {
      if (haystack[cursor] === character) {
        found = cursor;
        break;
      }
      cursor += 1;
    }
    if (found === -1) return null;

    if (runEnd !== -1 && found === runEnd + 1) {
      runEnd = found;
      consecutive += 1;
    } else {
      if (runStart !== -1) ranges.push([runStart, runEnd + 1]);
      runStart = found;
      runEnd = found;
      consecutive = 0;
    }

    score += 10 + consecutive * 6;
    const before = found === 0 ? "" : haystack[found - 1];
    if (found === 0 || before === " " || before === "\n" || before === "-" || before === "_") {
      score += 14;
    }
    cursor = found + 1;
  }

  if (runStart !== -1) ranges.push([runStart, runEnd + 1]);
  score -= Math.min(20, Math.round(text.length / 60));
  return { score, ranges };
}

function previewBody(body: string): string {
  const line = body
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (!line) return "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

export function searchNotes(notes: Note[], query: string, limit = 8): Match[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [...notes]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map((note) => ({
        note,
        score: 0,
        titleRanges: [],
        snippet: previewBody(note.body),
        snippetRanges: [],
      }));
  }

  const matches: Match[] = [];
  for (const note of notes) {
    const titleMatch = fuzzyMatch(note.title, trimmed);
    const bodyMatch = fuzzyMatch(note.body, trimmed);
    if (!titleMatch && !bodyMatch) continue;

    const score = (titleMatch ? titleMatch.score * 3 : 0) + (bodyMatch ? bodyMatch.score : 0);
    let snippet = previewBody(note.body);
    let snippetRanges: Range[] = [];

    if (bodyMatch && bodyMatch.ranges.length > 0) {
      const start = bodyMatch.ranges[0][0];
      const from = Math.max(0, start - 28);
      const raw = note.body.slice(from, from + 140).replace(/\s+/g, " ");
      snippet = `${from > 0 ? "…" : ""}${raw}${from + 140 < note.body.length ? "…" : ""}`;
      const shift = from > 0 ? 1 : 0;
      snippetRanges = bodyMatch.ranges
        .map(([a, b]) => [a - from + shift, b - from + shift] as Range)
        .filter(([a, b]) => a >= 0 && b <= snippet.length);
    }

    matches.push({ note, score, titleRanges: titleMatch?.ranges ?? [], snippet, snippetRanges });
  }

  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function highlight(text: string, ranges: Range[]): string {
  if (ranges.length === 0) return escapeHtml(text);
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let html = "";
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start < cursor || end <= start) continue;
    html += escapeHtml(text.slice(cursor, start));
    html += `<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}
