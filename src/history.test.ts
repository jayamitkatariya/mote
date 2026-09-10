import { describe, expect, it } from "vitest";
import { History, type Snapshot } from "./history";

function snap(body: string, start = body.length, end = start): Snapshot {
  return { body, start, end };
}

describe("History", () => {
  it("records a first snapshot on demand", () => {
    const history = new History();
    history.record("a", snap("hello"), { now: 1000 });
    expect(history.has("a")).toBe(true);
    expect(history.canUndo("a")).toBe(false);
    expect(history.canRedo("a")).toBe(false);
  });

  it("coalesces rapid edits into one step", () => {
    const history = new History();
    history.reset("a", snap("h"));
    history.record("a", snap("he"), { now: 1000 });
    history.record("a", snap("hel"), { now: 1300 });
    history.record("a", snap("hell"), { now: 1500 });
    history.record("a", snap("hello"), { now: 1700 });

    const undone = history.undo("a");
    expect(undone?.body).toBe("h");
    expect(history.canRedo("a")).toBe(true);
  });

  it("starts a new step after the coalesce window", () => {
    const history = new History();
    history.reset("a", snap("h"));
    history.record("a", snap("hi"), { now: 1000 });
    history.record("a", snap("hi there"), { now: 3000 });

    expect(history.undo("a")?.body).toBe("hi");
    expect(history.undo("a")?.body).toBe("h");
    expect(history.undo("a")).toBeNull();
  });

  it("redo replays undone states and typing clears the redo branch", () => {
    const history = new History();
    history.reset("a", snap("one"));
    history.record("a", snap("two"), { now: 0, coalesceMs: 0 });
    history.record("a", snap("three"), { now: 0, coalesceMs: 0 });

    expect(history.undo("a")?.body).toBe("two");
    expect(history.redo("a")?.body).toBe("three");

    expect(history.undo("a")?.body).toBe("two");
    history.record("a", snap("branch"), { now: 0, coalesceMs: 0 });
    expect(history.canRedo("a")).toBe(false);
    expect(history.undo("a")?.body).toBe("two");
    expect(history.undo("a")?.body).toBe("one");
  });

  it("keeps notes isolated from each other", () => {
    const history = new History();
    history.reset("a", snap("alpha"));
    history.reset("b", snap("beta"));
    history.record("a", snap("alpha!"), { now: 0, coalesceMs: 0 });

    expect(history.undo("b")).toBeNull();
    expect(history.undo("a")?.body).toBe("alpha");
    expect(history.canUndo("b")).toBe(false);
  });

  it("treats selection-only changes as the same step", () => {
    const history = new History();
    history.reset("a", snap("text", 0, 0));
    history.record("a", snap("text", 2, 2), { now: 1000 });
    expect(history.canUndo("a")).toBe(false);
  });

  it("caps stored steps", () => {
    const history = new History(3);
    history.reset("a", snap("0"));
    for (let index = 1; index <= 10; index += 1) {
      history.record("a", snap(String(index)), { now: 0, coalesceMs: 0 });
    }
    let undone = 0;
    while (history.undo("a")) undone += 1;
    expect(undone).toBe(2);
  });

  it("discards history for a note", () => {
    const history = new History();
    history.reset("a", snap("text"));
    history.discard("a");
    expect(history.has("a")).toBe(false);
    expect(history.undo("a")).toBeNull();
  });
});
