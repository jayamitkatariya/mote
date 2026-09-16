import { describe, expect, it } from "vitest";
import { MAX_TAGS, allTags, parseTags } from "./tags";

describe("parseTags", () => {
  it("finds hashtags anywhere in the body", () => {
    expect(parseTags("plan #work and #errands")).toEqual(["work", "errands"]);
    expect(parseTags("#top\nline two #nested")).toEqual(["top", "nested"]);
  });

  it("lowercases and dedupes while keeping order", () => {
    expect(parseTags("#Work #work #WORK #later")).toEqual(["work", "later"]);
  });

  it("does not match mid-word hashes or bare hashes", () => {
    expect(parseTags("foo#bar #")).toEqual([]);
    expect(parseTags("color: #ff0000")).toEqual(["ff0000"]);
  });

  it("allows unicode letters and dashes", () => {
    expect(parseTags("#café #week-1 #über")).toEqual(["café", "week-1", "über"]);
  });

  it("caps the number of tags", () => {
    const body = Array.from({ length: MAX_TAGS + 5 }, (_, index) => `#tag${index}`).join(" ");
    expect(parseTags(body)).toHaveLength(MAX_TAGS);
  });

  it("ignores tags longer than the limit", () => {
    expect(parseTags(`#${"a".repeat(40)}`)).toEqual([]);
  });
});

describe("allTags", () => {
  it("orders by frequency then alphabetically", () => {
    expect(allTags([["work", "home"], ["home"], ["zebra", "apple"]])).toEqual([
      "home",
      "apple",
      "work",
      "zebra",
    ]);
  });

  it("handles empty input", () => {
    expect(allTags([])).toEqual([]);
  });
});
