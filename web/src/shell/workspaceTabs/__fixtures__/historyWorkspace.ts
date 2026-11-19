// A minimal stand-in for the workspace tab store: tabs, selection and a leave
// guard, applying the history rules of the design so the
// timeline traces can be written as tables. The real store replaces it.

import { samePlace } from "../planOpen";
import {
  backTarget,
  currentVisit,
  forwardTarget,
  goBack,
  goForward,
  historyStartingAt,
  recordStep,
  removeTab,
  replaceCurrent,
  replaceNewTab,
  type WorkspaceHistoryState,
} from "../workspaceHistory";
import type { BrowserEntry, TabId, Visit, WorkspacePlace } from "../workspacePlace";

export interface FakeTab {
  id: TabId;
  place: WorkspacePlace;
  entry?: BrowserEntry;
  dirty?: boolean;
  /** Shown after a background open into an unselected, clean tab. */
  dot?: boolean;
  /** The one Files tab, which navigates in place and which agents never move. */
  role?: "files";
  /** A background open waiting to be shown in a selected, dirty or Files tab. */
  attention?: WorkspacePlace;
}

export class HistoryWorkspace {
  tabs: FakeTab[] = [];
  selectedTabId: TabId;
  history: WorkspaceHistoryState;
  /** The leave guard's answer for the next guarded navigation. */
  guardAnswer: "leave" | "cancel" = "leave";
  readonly guardCalls: TabId[][] = [];
  constructor(first: FakeTab) {
    this.tabs.push(first);
    this.selectedTabId = first.id;
    this.history = historyStartingAt(this.visitOf(first));
  }

  tab(id: TabId): FakeTab {
    const tab = this.tabs.find((candidate) => candidate.id === id);
    if (!tab) throw new Error(`no tab ${id}`);
    return tab;
  }

  /** An open that selects its tab: a step. New tabs go after the selected one. */
  openSelected(tab: FakeTab): void {
    this.insertAfterSelected(tab);
    this.selectedTabId = tab.id;
    this.history = recordStep(this.history, this.visitOf(tab));
  }

  /** An agent's open: never selects and never a step. */
  openInBackground(tab: FakeTab): void {
    const existing = this.tabs.find((candidate) => candidate.id === tab.id);
    if (!existing) {
      this.insertAfterSelected({ ...tab, dot: true });
      return;
    }
    if (existing.id === this.selectedTabId || existing.dirty || existing.role === "files") {
      existing.attention = tab.place;
    } else Object.assign(existing, { place: tab.place, dot: true });
  }

  /** The user selects a tab: a step for whatever it shows. */
  select(id: TabId): void {
    if (id === this.selectedTabId) return;
    this.selectedTabId = id;
    const tab = this.tab(id);
    tab.dot = false;
    this.history = recordStep(this.history, this.visitOf(tab));
  }

  /** In-tab navigation (a PR sub-view, a file from the tree): a step through the guard. */
  async navigate(id: TabId, place: WorkspacePlace): Promise<"leave" | "cancel"> {
    const tab = this.tab(id);
    if (tab.dirty && (await this.askToLeave([id])) === "cancel") return "cancel";
    tab.place = place;
    tab.dirty = false;
    if (id === this.selectedTabId) this.history = recordStep(this.history, this.visitOf(tab));
    else this.select(id);
    return "leave";
  }

  /** A line or comment move within the same tab and path: replaces the cursor visit when that tab is selected. */
  moveWithin(id: TabId, place: WorkspacePlace): void {
    const tab = this.tab(id);
    tab.place = place;
    if (id === this.selectedTabId) this.history = replaceCurrent(this.history, this.visitOf(tab));
    else this.select(id);
  }

  /** The new-tab page became an app, in the same tab or a bound tab in its slot. */
  pickApp(newTabId: TabId, app: FakeTab): void {
    const index = this.tabs.findIndex((tab) => tab.id === newTabId);
    this.tabs.splice(index, 1, app);
    if (this.selectedTabId === newTabId) this.selectedTabId = app.id;
    this.history = replaceNewTab(this.history, newTabId, this.visitOf(app));
  }

  /** Back or Forward: guard, then move the cursor, select and land. Resolves once landing has started. */
  async back(): Promise<{ moved: boolean }> {
    return this.step(-1);
  }

  async forward(): Promise<{ moved: boolean }> {
    return this.step(1);
  }

  canGoBack(): boolean {
    return backTarget(this.history) !== null;
  }

  canGoForward(): boolean {
    return forwardTarget(this.history) !== null;
  }

  async close(id: TabId): Promise<"leave" | "cancel"> {
    if (this.tab(id).dirty && (await this.askToLeave([id])) === "cancel") return "cancel";
    const wasSelected = id === this.selectedTabId;
    this.tabs = this.tabs.filter((tab) => tab.id !== id);
    const { state, restore } = removeTab(this.history, id);
    this.history = state;
    if (!wasSelected) return "leave";
    if (restore) {
      this.selectedTabId = restore.tabId;
      this.show(restore);
      return "leave";
    }
    const fresh: FakeTab = { id: `new-${this.tabs.length}`, place: { kind: "new" } };
    this.tabs.push(fresh);
    this.selectedTabId = fresh.id;
    this.history = historyStartingAt(this.visitOf(fresh));
    return "leave";
  }

  /** The design's invariant: the cursor visit belongs to the selected tab and equals its place. */
  invariantHolds(): boolean {
    const visit = currentVisit(this.history);
    const tab = this.tab(this.selectedTabId);
    return (
      visit !== null &&
      visit.tabId === tab.id &&
      samePlace(visit.place, tab.place) &&
      visit.entry?.index === tab.entry?.index
    );
  }

  private async step(direction: -1 | 1): Promise<{ moved: boolean }> {
    const target = direction < 0 ? backTarget(this.history) : forwardTarget(this.history);
    if (!target) return { moved: false };
    const tab = this.tab(target.tabId);
    const changesPlace = !samePlace(tab.place, target.place);
    if (changesPlace && tab.dirty && (await this.askToLeave([tab.id])) === "cancel")
      return { moved: false };
    this.history = direction < 0 ? goBack(this.history) : goForward(this.history);
    this.selectedTabId = tab.id;
    this.show(target);
    return { moved: true };
  }

  private show(visit: Visit): void {
    const tab = this.tab(visit.tabId);
    tab.place = visit.place;
    tab.dirty = false;
  }

  private async askToLeave(tabIds: TabId[]): Promise<"leave" | "cancel"> {
    this.guardCalls.push(tabIds);
    return this.guardAnswer;
  }

  private insertAfterSelected(tab: FakeTab): void {
    const index = this.tabs.findIndex((candidate) => candidate.id === this.selectedTabId);
    this.tabs.splice(index + 1, 0, tab);
  }

  private visitOf(tab: FakeTab): Visit {
    return tab.entry
      ? { tabId: tab.id, place: tab.place, entry: tab.entry }
      : { tabId: tab.id, place: tab.place };
  }
}

/** The design's trace notation: `[F:a.ts, P:#12*]`. */
export function describeHistory(history: WorkspaceHistoryState): string {
  const parts = history.visits.map(
    (visit, index) => describeVisit(visit) + (index === history.cursor ? "*" : ""),
  );
  return `[${parts.join(", ")}]`;
}

function describeVisit(visit: Visit): string {
  const detail = describePlace(visit.place, visit.entry);
  return detail ? `${visit.tabId}:${detail}` : visit.tabId;
}

function describePlace(place: WorkspacePlace, entry: BrowserEntry | undefined): string {
  switch (place.kind) {
    case "files":
      return place.path ? place.path + (place.line ? `:${place.line.start}` : "") : "";
    case "changes":
      return place.path ?? "";
    case "pull": {
      const number = `#${place.url.split("/").at(-1)}`;
      const view = place.view === "summary" ? "" : `/${place.view}`;
      return number + view + (place.path ? `:${place.path}` : "");
    }
    case "web":
      return (place.url ? new URL(place.url).pathname : "") + (entry ? `#${entry.index}` : "");
    default:
      return "";
  }
}
