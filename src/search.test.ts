import { describe, expect, it } from "vitest";
import { fuzzyMatch, highlight, searchNotes } from "./search";
import type { Note } from "./types";

function note(id: string, title: string, body: string, updatedAt = 1): Note {
  return { id, title, body, createdAt: updatedAt, updatedAt, tags: [], attachments: [] };
}

describe("fuzzyMatch", () => {
  it("matches subsequences", () => {
    const result = fuzzyMatch("shopping list", "spl");
    expect(result).not.toBeNull();
    expect(result?.ranges.length).toBeGreaterThan(0);
  });

  it("rejects missing characters", () => {
    expect(fuzzyMatch("shopping list", "zzz")).toBeNull();
  });

  it("returns an empty match for an empty query", () => {
    expect(fuzzyMatch("anything", "")).toEqual({ score: 0, ranges: [] });
  });
});

describe("searchNotes", () => {
  const notes = [
    note("1", "meeting notes", "discuss roadmap and hiring", 30),
    note("2", "grocery list", "milk, eggs, coffee beans", 20),
    note("3", "random thoughts", "the roadmap needs a rewrite", 10),
  ];

  it("ranks title matches above body matches", () => {
    const results = searchNotes(notes, "roadmap");
    expect(results[0].note.id).toBe("1");
  });

  it("falls back to recency for an empty query", () => {
    const results = searchNotes(notes, "");
    expect(results.map((match) => match.note.id)).toEqual(["1", "2", "3"]);
  });

  it("returns nothing when there is no match", () => {
    expect(searchNotes(notes, "quantum")).toHaveLength(0);
  });

  it("builds a highlighted snippet for body matches", () => {
    const results = searchNotes(notes, "coffee");
    expect(results[0].note.id).toBe("2");
    expect(results[0].snippet).toContain("coffee");
    expect(results[0].snippetRanges.length).toBeGreaterThan(0);
  });

  it("still finds closed notes", () => {
    const archived: Note = { ...note("4", "old ideas", "a closed thought", 5), closedAt: 99 };
    const results = searchNotes([...notes, archived], "closed thought");
    expect(results[0].note.id).toBe("4");
  });
});

describe("highlight", () => {
  it("escapes html and wraps ranges", () => {
    const html = highlight("a <b> c", [[0, 1]]);
    expect(html).toBe("<mark>a</mark> &lt;b&gt; c");
  });

  it("escapes when there are no ranges", () => {
    expect(highlight("<script>", [])).toBe("&lt;script&gt;");
  });
});
