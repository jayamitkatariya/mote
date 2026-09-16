import type { NoteColor } from "./types";

export interface Swatch {
  id: NoteColor;
  label: string;
  hex: string;
}

export const NOTE_COLORS: Swatch[] = [
  { id: "yellow", label: "yellow", hex: "#ffd60a" },
  { id: "orange", label: "orange", hex: "#ff9f0a" },
  { id: "pink", label: "pink", hex: "#ff375f" },
  { id: "purple", label: "purple", hex: "#bf5af2" },
  { id: "blue", label: "blue", hex: "#0a84ff" },
  { id: "green", label: "green", hex: "#30d158" },
  { id: "gray", label: "gray", hex: "#8e8e93" },
];

export function isNoteColor(value: unknown): value is NoteColor {
  return typeof value === "string" && NOTE_COLORS.some((swatch) => swatch.id === value);
}

export function swatchFor(color: NoteColor | undefined): Swatch | null {
  return NOTE_COLORS.find((swatch) => swatch.id === color) ?? null;
}
