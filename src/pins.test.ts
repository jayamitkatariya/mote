import { describe, expect, it } from "vitest";
import { noteIdFromLabel, pinLabel, togglePinId } from "./pins";

describe("pin labels", () => {
  it("round-trips a note id", () => {
    const id = "0d1f4b6a-1234-4abc-9def-000000000000";
    expect(noteIdFromLabel(pinLabel(id))).toBe(id);
  });

  it("rejects labels that are not pins", () => {
    expect(noteIdFromLabel("main")).toBeNull();
    expect(noteIdFromLabel("pin-")).toBeNull();
  });
});

describe("togglePinId", () => {
  it("adds missing ids", () => {
    expect(togglePinId([], "a")).toEqual(["a"]);
    expect(togglePinId(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes existing ids", () => {
    expect(togglePinId(["a", "b"], "a")).toEqual(["b"]);
  });

  it("does not mutate the input", () => {
    const ids = ["a"];
    togglePinId(ids, "b");
    expect(ids).toEqual(["a"]);
  });
});
