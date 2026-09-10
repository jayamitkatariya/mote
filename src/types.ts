export interface Note {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface Settings {
  shakeEnabled: boolean;
  shakeSensitivity: number;
  hideOnBlur: boolean;
  pinnedIds: string[];
}

export interface Doc {
  version: 1;
  notes: Note[];
  tabOrder: string[];
  activeId: string | null;
  settings: Settings;
}
