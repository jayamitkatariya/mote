export type NoteColor = "yellow" | "orange" | "pink" | "purple" | "blue" | "green" | "gray";

export interface Attachment {
  id: string;
  name: string;
  ext: string;
  size: number;
  createdAt: number;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  color?: NoteColor;
  tags: string[];
  attachments: Attachment[];
}

export interface Settings {
  shakeEnabled: boolean;
  shakeSensitivity: number;
  hideOnBlur: boolean;
  pinnedIds: string[];
  stickyOpacity: number;
}

export interface Doc {
  version: 2;
  notes: Note[];
  tabOrder: string[];
  activeId: string | null;
  settings: Settings;
}
