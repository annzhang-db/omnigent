import { describe, expect, it } from "vitest";

import { describeHistory, HistoryWorkspace, type FakeTab } from "./__fixtures__/historyWorkspace";
import {
  alignWithSelection,
  backTarget,
  cursorMatches,
  EMPTY_WORKSPACE_HISTORY,
  forwardTarget,
  goBack,
  goForward,
  historyStartingAt,
  moveCursorTo,
  recordStep,
  removeTab,
  replaceCurrent,
  replaceCursorVisit,
  replaceNewTab,
  restoreHistory,
  serializeHistory,
  WORKSPACE_HISTORY_LIMIT,
  WorkspaceHistory,
  type WorkspaceHistoryState,
} from "./workspaceHistory";
import type { Visit, WorkspacePlace } from "./workspacePlace";

const PR_12 = "https://github.com/o/r/pull/12";

function file(path: string, line?: number): WorkspacePlace {
  return line === undefined
    ? { kind: "files", path }
    : { kind: "files", path, line: { start: line } };
}
function pull(view: "summary" | "changes" = "summary", path?: string): WorkspacePlace {
  return path === undefined
    ? { kind: "pull", url: PR_12, view }
    : { kind: "pull", url: PR_12, view, path };
}
function tab(id: string, place: WorkspacePlace, extra: Partial<FakeTab> = {}): FakeTab {
  return { id, place, ...extra };
}
function visit(tabId: string, place: WorkspacePlace): Visit {
  return { tabId, place };
}

interface TraceStep {
  name: string;
  run: (workspace: HistoryWorkspace) => unknown;
  timeline: string;
  selected?: string;
}

interface Trace {
  name: string;
  setup: () => HistoryWorkspace;
  steps: TraceStep[];
}

// Traces 1-9 of the design's history section. The invariant is checked after every step.
const traces: Trace[] = [
  {
    name: "1. an agent's background open is not a step until the user selects it",
    setup: () => new HistoryWorkspace(tab("F", file("a.ts"))),
    steps: [
      {
        name: "agent opens PR #12",
        run: (ws) => ws.openInBackground(tab("P", pull())),
        timeline: "[F:a.ts*]",
        selected: "F",
      },
      { name: "user clicks P", run: (ws) => ws.select("P"), timeline: "[F:a.ts, P:#12*]" },
      { name: "Back", run: (ws) => ws.back(), timeline: "[F:a.ts*, P:#12]", selected: "F" },
    ],
  },
  {
    name: "2. in-tab steps are steps, and Back walks them",
    setup: () => new HistoryWorkspace(tab("F", file("a"))),
    steps: [
      {
        name: "a chat link opens #12",
        run: (ws) => ws.openSelected(tab("P", pull())),
        timeline: "[F:a, P:#12*]",
      },
      {
        name: "Changes",
        run: (ws) => ws.navigate("P", pull("changes")),
        timeline: "[F:a, P:#12, P:#12/changes*]",
      },
      {
        name: "main.go",
        run: (ws) => ws.navigate("P", pull("changes", "main.go")),
        timeline: "[F:a, P:#12, P:#12/changes, P:#12/changes:main.go*]",
      },
      {
        name: "Back",
        run: (ws) => ws.back(),
        timeline: "[F:a, P:#12, P:#12/changes*, P:#12/changes:main.go]",
      },
      {
        name: "Back",
        run: (ws) => ws.back(),
        timeline: "[F:a, P:#12*, P:#12/changes, P:#12/changes:main.go]",
      },
      {
        name: "Back",
        run: (ws) => ws.back(),
        timeline: "[F:a*, P:#12, P:#12/changes, P:#12/changes:main.go]",
        selected: "F",
      },
    ],
  },
  {
    name: "3. closing the selected tab lands on the nearest earlier visit",
    setup: () => {
      const ws = new HistoryWorkspace(tab("F", file("a")));
      ws.openSelected(tab("C", { kind: "changes", path: "x.go" }));
      ws.openSelected(tab("F2", file("b.ts")));
      return ws;
    },
    steps: [
      { name: "close F2", run: (ws) => ws.close("F2"), timeline: "[F:a, C:x.go*]", selected: "C" },
    ],
  },
  {
    name: "4. closing with Forward keeps Forward",
    setup: () => {
      const ws = new HistoryWorkspace(tab("F", file("a")));
      ws.openSelected(tab("C", { kind: "changes", path: "x" }));
      ws.openSelected(tab("P", pull()));
      return ws;
    },
    steps: [
      { name: "Back", run: (ws) => ws.back(), timeline: "[F:a, C:x*, P:#12]" },
      { name: "close C", run: (ws) => ws.close("C"), timeline: "[F:a*, P:#12]", selected: "F" },
      { name: "Forward", run: (ws) => ws.forward(), timeline: "[F:a, P:#12*]", selected: "P" },
    ],
  },
  {
    name: "5a. a line move in the selected tab replaces the cursor visit",
    setup: () => new HistoryWorkspace(tab("F", file("a.ts", 10))),
    steps: [
      {
        name: "link to a.ts:40",
        run: (ws) => ws.moveWithin("F", file("a.ts", 40)),
        timeline: "[F:a.ts:40*]",
      },
    ],
  },
  {
    name: "5b. the same move into another tab is a tab switch and appends",
    setup: () => {
      const ws = new HistoryWorkspace(tab("F", file("a.ts", 10)));
      ws.openSelected(tab("P", pull()));
      return ws;
    },
    steps: [
      {
        name: "link to a.ts:40",
        run: (ws) => ws.moveWithin("F", file("a.ts", 40)),
        timeline: "[F:a.ts:10, P:#12, F:a.ts:40*]",
        selected: "F",
      },
    ],
  },
  {
    name: "6. a background open into a visited, unselected, clean file tab navigates it silently",
    setup: () => {
      const ws = new HistoryWorkspace(tab("A", file("a.ts")));
      ws.openSelected(tab("P", pull()));
      return ws;
    },
    steps: [
      {
        name: "agent opens b.ts in A",
        run: (ws) => ws.openInBackground(tab("A", file("b.ts"))),
        timeline: "[A:a.ts, P:#12*]",
        selected: "P",
      },
      { name: "user selects A", run: (ws) => ws.select("A"), timeline: "[A:a.ts, P:#12, A:b.ts*]" },
      { name: "Back", run: (ws) => ws.back(), timeline: "[A:a.ts, P:#12*, A:b.ts]", selected: "P" },
      { name: "Back", run: (ws) => ws.back(), timeline: "[A:a.ts*, P:#12, A:b.ts]", selected: "A" },
    ],
  },
  {
    name: "7. Cancel in the leave guard changes nothing",
    setup: () => {
      const ws = new HistoryWorkspace(tab("F", file("z.ts")));
      ws.openSelected(tab("P", pull()));
      Object.assign(ws.tab("F"), { place: file("a.ts"), dirty: true });
      ws.guardAnswer = "cancel";
      return ws;
    },
    steps: [
      {
        name: "Back → Cancel",
        run: (ws) => ws.back(),
        timeline: "[F:z.ts, P:#12*]",
        selected: "P",
      },
    ],
  },
  {
    name: "8. new tab → shell; the new-tab page is never a place Back returns to",
    setup: () => new HistoryWorkspace(tab("F", file("a"))),
    steps: [
      {
        name: '"+"',
        run: (ws) => ws.openSelected(tab("N", { kind: "new" })),
        timeline: "[F:a, N*]",
      },
      {
        name: "pick Terminal",
        run: (ws) => ws.pickApp("N", tab("T", { kind: "terminal", key: "k1" })),
        timeline: "[F:a, T*]",
        selected: "T",
      },
      { name: "Back", run: (ws) => ws.back(), timeline: "[F:a*, T]", selected: "F" },
      { name: "Forward", run: (ws) => ws.forward(), timeline: "[F:a, T*]", selected: "T" },
      { name: "close T", run: (ws) => ws.close("T"), timeline: "[F:a*]", selected: "F" },
    ],
  },
  {
    name: "9. `current` into a bound place opens a new tab and leaves F unchanged",
    setup: () => new HistoryWorkspace(tab("F", file("a"))),
    steps: [
      {
        name: "omnigent://terminal/k1 with current",
        run: (ws) => ws.openSelected(tab("T1", { kind: "terminal", key: "k1" })),
        timeline: "[F:a, T1*]",
        selected: "T1",
      },
    ],
  },
];

describe("workspace history traces", () => {
  it.each(traces)("$name", async ({ setup, steps }) => {
    const workspace = setup();
    expect(workspace.invariantHolds()).toBe(true);
    for (const step of steps) {
      // Each step acts on the state the previous one left.
      // oxlint-disable-next-line no-await-in-loop
      await step.run(workspace);
      expect(describeHistory(workspace.history), step.name).toBe(step.timeline);
      if (step.selected) expect(workspace.selectedTabId, step.name).toBe(step.selected);
      expect(workspace.invariantHolds(), `invariant after ${step.name}`).toBe(true);
    }
  });

  it("2. Back into an in-tab step navigates that tab in place", async () => {
    const ws = new HistoryWorkspace(tab("F", file("a")));
    ws.openSelected(tab("P", pull()));
    await ws.navigate("P", pull("changes", "main.go"));
    await ws.back();
    expect(ws.tab("P").place).toEqual(pull());
  });

  it("6. Back into A navigates it back to the file it showed", async () => {
    const ws = new HistoryWorkspace(tab("A", file("a.ts")));
    ws.openSelected(tab("P", pull()));
    ws.openInBackground(tab("A", file("b.ts")));
    expect(ws.tab("A").dot).toBe(true);
    ws.select("A");
    await ws.back();
    await ws.back();
    expect(ws.tab("A").place).toEqual(file("a.ts"));
  });

  it("6. the same open naming the Files tab only sets attention, since agents never move it", () => {
    const ws = new HistoryWorkspace(tab("F", file("a.ts"), { role: "files" }));
    ws.openSelected(tab("P", pull()));
    ws.openInBackground(tab("F", file("b.ts")));
    expect(ws.tab("F")).toMatchObject({ place: file("a.ts"), attention: file("b.ts") });
    expect(describeHistory(ws.history)).toBe("[F:a.ts, P:#12*]");
  });

  it("7. Cancel asks once and leaves the dirty tab's place; Leave navigates it", async () => {
    const ws = new HistoryWorkspace(tab("F", file("z.ts")));
    ws.openSelected(tab("P", pull()));
    Object.assign(ws.tab("F"), { place: file("a.ts"), dirty: true });
    ws.guardAnswer = "cancel";
    await ws.back();
    expect(ws.guardCalls).toEqual([["F"]]);
    expect(ws.tab("F").place).toEqual(file("a.ts"));

    ws.guardAnswer = "leave";
    await ws.back();
    expect(describeHistory(ws.history)).toBe("[F:z.ts*, P:#12]");
    expect(ws.tab("F").place).toEqual(file("z.ts"));
  });

  it("1. an agent's open into the selected or a dirty tab only sets attention", () => {
    const ws = new HistoryWorkspace(tab("F", file("a.ts")));
    ws.openInBackground(tab("F", file("main.go")));
    expect(ws.tab("F").place).toEqual(file("a.ts"));
    expect(ws.tab("F").attention).toEqual(file("main.go"));
    expect(describeHistory(ws.history)).toBe("[F:a.ts*]");
  });

  it("closing the last visited tab opens a new-tab page with a fresh timeline", async () => {
    const ws = new HistoryWorkspace(tab("F", file("a")));
    await ws.close("F");
    expect(describeHistory(ws.history)).toBe("[new-0*]");
    expect(ws.invariantHolds()).toBe(true);
  });

  it("closing an unselected tab only removes its visits", async () => {
    const ws = new HistoryWorkspace(tab("F", file("a")));
    ws.openSelected(tab("P", pull()));
    ws.openSelected(tab("C", { kind: "changes", path: "x" }));
    await ws.close("P");
    expect(describeHistory(ws.history)).toBe("[F:a, C:x*]");
    expect(ws.selectedTabId).toBe("C");
  });
});

describe("recordStep", () => {
  const start = historyStartingAt(visit("F", file("a")));

  it("drops Forward after a new step", () => {
    const three = recordStep(
      recordStep(start, visit("P", pull())),
      visit("C", { kind: "changes" }),
    );
    const afterBack = goBack(goBack(three));
    const stepped = recordStep(afterBack, visit("S", { kind: "search" }));
    expect(describeHistory(stepped)).toBe("[F:a, S*]");
    expect(forwardTarget(stepped)).toBeNull();
  });

  it("does nothing for the visit the cursor is already on", () => {
    expect(recordStep(start, visit("F", file("a")))).toBe(start);
  });

  it("keeps the newest 100 visits and the cursor on the last", () => {
    let state: WorkspaceHistoryState = EMPTY_WORKSPACE_HISTORY;
    for (let index = 0; index < WORKSPACE_HISTORY_LIMIT + 5; index++) {
      state = recordStep(state, visit("F", file(`f${index}.ts`)));
    }
    expect(state.visits).toHaveLength(WORKSPACE_HISTORY_LIMIT);
    expect(state.visits[0]).toEqual(visit("F", file("f5.ts")));
    expect(state.cursor).toBe(WORKSPACE_HISTORY_LIMIT - 1);
  });

  it("starts an empty timeline", () => {
    expect(describeHistory(recordStep(EMPTY_WORKSPACE_HISTORY, visit("F", file("a"))))).toBe(
      "[F:a*]",
    );
  });
});

describe("replaceCursorVisit", () => {
  const shell = (key: string): WorkspacePlace => ({ kind: "terminal", key });

  it("steps over focus moves inside a split: Back lands on the visit before it", () => {
    // A file, then a split's panes A, B and C focused in turn.
    let state = recordStep(historyStartingAt(visit("F", file("a.ts"))), visit("A", shell("a")));
    state = replaceCursorVisit(state, visit("B", shell("b")));
    state = replaceCursorVisit(state, visit("C", shell("c")));
    expect(describeHistory(state)).toBe("[F:a.ts, C*]");
  });

  it("collapses a move back onto the pane the previous visit already shows", () => {
    // Focus left the split for B's own visit, then came back through A onto B again.
    let state = recordStep(historyStartingAt(visit("B", shell("b"))), visit("A", shell("a")));
    state = replaceCursorVisit(state, visit("B", shell("b")));
    expect(describeHistory(state)).toBe("[B*]");
  });

  it("changes nothing for the visit the cursor already holds", () => {
    const state = historyStartingAt(visit("A", shell("a")));
    expect(replaceCursorVisit(state, visit("A", shell("a")))).toBe(state);
  });
});

describe("replaceCurrent", () => {
  it("never touches a visit other than the cursor's", () => {
    const state = goBack(
      recordStep(historyStartingAt(visit("F", file("a.ts", 1))), visit("F", file("b.ts"))),
    );
    const replaced = replaceCurrent(state, visit("F", file("a.ts", 9)));
    expect(describeHistory(replaced)).toBe("[F:a.ts:9*, F:b.ts]");
  });

  it("appends when the cursor visit belongs to another tab", () => {
    const state = historyStartingAt(visit("P", pull()));
    expect(describeHistory(replaceCurrent(state, visit("F", file("a.ts", 9))))).toBe(
      "[P:#12, F:a.ts:9*]",
    );
  });

  it("collapses into an identical neighbour instead of leaving a no-op Back", () => {
    const state = recordStep(
      historyStartingAt(visit("W", { kind: "web", url: "https://x.test/a" })),
      {
        tabId: "W",
        place: { kind: "web", url: "https://x.test/redirecting" },
      },
    );
    const replaced = replaceCurrent(state, visit("W", { kind: "web", url: "https://x.test/a" }));
    expect(describeHistory(replaced)).toBe("[W:/a*]");
  });
});

describe("replaceNewTab", () => {
  it("turns the new-tab page into an app in the same tab without a step", () => {
    const state = recordStep(historyStartingAt(visit("F", file("a"))), visit("N", { kind: "new" }));
    expect(describeHistory(replaceNewTab(state, "N", visit("N", { kind: "changes" })))).toBe(
      "[F:a, N*]",
    );
  });

  it("puts a bound tab in the new-tab page's slot and drops its other visits", () => {
    let state = recordStep(historyStartingAt(visit("N", { kind: "new" })), visit("F", file("a")));
    state = recordStep(state, visit("N", { kind: "new" }));
    const replaced = replaceNewTab(state, "N", visit("T", { kind: "terminal", key: "k" }));
    expect(describeHistory(replaced)).toBe("[F:a, T*]");
  });

  it("appends when the new-tab page has no visit", () => {
    const state = historyStartingAt(visit("F", file("a")));
    expect(
      describeHistory(replaceNewTab(state, "N", visit("T", { kind: "terminal", key: "k" }))),
    ).toBe("[F:a, T*]");
  });
});

describe("removeTab", () => {
  it("moves to the nearest later visit when nothing earlier survives", () => {
    const state = goBack(recordStep(historyStartingAt(visit("F", file("a"))), visit("P", pull())));
    const { state: next, restore } = removeTab(state, "F");
    expect(describeHistory(next)).toBe("[P:#12*]");
    expect(restore).toEqual(visit("P", pull()));
  });

  it("returns no visit when the cursor was elsewhere, keeping the cursor on its visit", () => {
    let state = historyStartingAt(visit("F", file("a")));
    state = recordStep(state, visit("P", pull()));
    state = recordStep(state, visit("C", { kind: "changes" }));
    const { state: next, restore } = removeTab(state, "F");
    expect(restore).toBeNull();
    expect(describeHistory(next)).toBe("[P:#12, C*]");
  });

  it("collapses the identical neighbours a removal leaves behind", () => {
    let state = historyStartingAt(visit("F", file("a")));
    state = recordStep(state, visit("C", { kind: "changes", path: "x" }));
    state = recordStep(state, visit("F", file("a")));
    const { state: next, restore } = removeTab(state, "C");
    expect(describeHistory(next)).toBe("[F:a*]");
    expect(restore).toBeNull();
  });

  it("returns null with an empty timeline when nothing survives", () => {
    const { state, restore } = removeTab(historyStartingAt(visit("F", file("a"))), "F");
    expect(state).toEqual(EMPTY_WORKSPACE_HISTORY);
    expect(restore).toBeNull();
  });

  it("leaves a timeline without that tab untouched", () => {
    const state = historyStartingAt(visit("F", file("a")));
    expect(removeTab(state, "P").state).toBe(state);
  });
});

describe("back and forward", () => {
  const state = goBack(
    recordStep(historyStartingAt(visit("F", file("a"))), visit("W", { kind: "web" })),
  );

  it("targets without moving the cursor", () => {
    expect(forwardTarget(state)).toEqual(visit("W", { kind: "web" }));
    expect(state.cursor).toBe(0);
    expect(backTarget(state)).toBeNull();
    expect(goBack(state)).toBe(state);
  });

  it("is disabled onto a blocked visit, not skipped past it", () => {
    const blocked = { isBlocked: (target: Visit) => target.tabId === "W" };
    expect(forwardTarget(state, blocked)).toBeNull();
    expect(goForward(state, blocked)).toBe(state);
  });

  it("moveCursorTo keeps the timeline and ignores out-of-range indexes", () => {
    const forward = goForward(state);
    expect(moveCursorTo(forward, 0).visits).toBe(forward.visits);
    expect(moveCursorTo(forward, 0).cursor).toBe(0);
    expect(moveCursorTo(forward, 7)).toBe(forward);
  });
});

describe("alignWithSelection", () => {
  it("replaces the cursor visit of the selected tab and steps into another", () => {
    const state = historyStartingAt(visit("F", file("a", 1)));
    expect(describeHistory(alignWithSelection(state, visit("F", file("a", 5))))).toBe("[F:a:5*]");
    expect(describeHistory(alignWithSelection(state, visit("P", pull())))).toBe("[F:a:1, P:#12*]");
    expect(cursorMatches(state, "F", file("a", 1))).toBe(true);
    expect(cursorMatches(state, "F", file("a", 2))).toBe(false);
  });
});

describe("visits compare places by their canonical link", () => {
  it("a place that differs only by an unset field is not a new step", () => {
    const state = historyStartingAt(visit("F", { kind: "files", path: "a" }));
    expect(recordStep(state, visit("F", { kind: "files", path: "a", line: undefined }))).toBe(
      state,
    );
    expect(recordStep(state, visit("F", file("a", 2)))).not.toBe(state);
  });
});

describe("serialize and restore", () => {
  it("round-trips", () => {
    let state = historyStartingAt(visit("F", file("a", 3)));
    state = recordStep(state, {
      tabId: "W",
      place: { kind: "web", url: "https://x.test/a" },
      entry: { index: 2 },
    });
    state = goBack(state);
    const json = JSON.parse(JSON.stringify(serializeHistory(state)));
    expect(restoreHistory(json, () => true)).toEqual(state);
  });

  it("drops malformed visits and visits of tabs that no longer exist, keeping the cursor on its visit", () => {
    const raw = {
      visits: [
        { tabId: "F", place: { kind: "files", path: "a" } },
        { tabId: "", place: { kind: "files" } },
        { tabId: "gone", place: { kind: "pulls" } },
        { tabId: "P", place: "not a place" },
        { tabId: "C", place: { kind: "changes" }, entry: { index: -1 } },
        { tabId: "S", place: { kind: "search" } },
      ],
      cursor: 4,
    };
    const restored = restoreHistory(raw, (tabId) => tabId !== "gone");
    expect(describeHistory(restored)).toBe("[F:a, C*, S]");
    expect(restored.visits[1]).toEqual(visit("C", { kind: "changes" }));
  });

  it("falls back to the nearest earlier survivor, else the first", () => {
    const raw = {
      visits: [
        { tabId: "gone", place: { kind: "pulls" } },
        { tabId: "F", place: { kind: "files" } },
      ],
      cursor: 0,
    };
    expect(describeHistory(restoreHistory(raw, (tabId) => tabId !== "gone"))).toBe("[F*]");
  });

  it.each([null, "x", [], { visits: "no" }, { visits: [] }])("treats %j as empty", (raw) => {
    expect(restoreHistory(raw, () => true)).toEqual(EMPTY_WORKSPACE_HISTORY);
  });
});

describe("WorkspaceHistory", () => {
  it("exposes the store-facing methods over the pure functions", () => {
    const history = new WorkspaceHistory(historyStartingAt(visit("F", file("a"))));
    history.recordStep(visit("P", pull()));
    expect(history.canGoBack()).toBe(true);
    expect(history.backTarget()).toEqual(visit("F", file("a")));
    expect(history.back()).toEqual(visit("F", file("a")));
    expect(history.canGoForward()).toBe(true);
    expect(history.forward()).toEqual(visit("P", pull()));
    history.replaceCurrent(visit("P", pull("changes")));
    expect(history.removeTab("P")).toEqual(visit("F", file("a")));
    history.replaceNewTab("F", visit("T", { kind: "terminal", key: "k" }));
    expect(describeHistory(history.state)).toBe("[T*]");
    const copy = new WorkspaceHistory();
    copy.restore(history.serialize(), () => true);
    expect(copy.state).toEqual(history.state);
    expect(copy.back()).toBeNull();
  });
});
