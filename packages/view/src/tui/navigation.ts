// Pure TUI navigation state: which Step is selected, whether the detail pane auto-follows the active
// Step, the active inspector tab, and the help toggle. Kept free of OpenTUI and of any default
// Step-name knowledge so it can be unit-tested in isolation and stays Pipeline-generic.

import type { ViewState } from "../present.ts";

export const TABS = ["summary", "artifacts", "findings", "rounds"] as const;
export type Tab = (typeof TABS)[number];

export interface NavState {
  /** Index into `view.steps` chosen by the user; ignored while `followActive` is on. */
  readonly selectedIndex: number;
  /** When true, the selection tracks the active Step; any manual move turns it off. */
  readonly followActive: boolean;
  readonly tab: Tab;
  readonly showHelp: boolean;
  /** Whether long artifact/finding bodies are expanded in the inspector. */
  readonly expanded: boolean;
}

export const initialNav: NavState = {
  selectedIndex: 0,
  followActive: true,
  tab: "summary",
  showHelp: false,
  expanded: false,
};

/** A minimal keyboard event shape - decoupled from OpenTUI's `KeyEvent` so this stays unit-testable. */
export interface KeyLike {
  readonly name: string;
  readonly shift?: boolean;
}

function indexOfActive(view: ViewState): number {
  const i = view.steps.findIndex((s) => s.name === view.activeStep);
  return i >= 0 ? i : -1;
}

/** The effective selected Step index, honouring follow-active and clamping to the Pipeline length. */
export function effectiveIndex(nav: NavState, view: ViewState): number {
  if (view.steps.length === 0) return 0;
  const active = indexOfActive(view);
  const base = nav.followActive && active >= 0 ? active : nav.selectedIndex;
  return Math.max(0, Math.min(base, view.steps.length - 1));
}

/** The currently selected Step's name, or undefined for an empty Pipeline. */
export function selectedStepName(nav: NavState, view: ViewState): string | undefined {
  return view.steps[effectiveIndex(nav, view)]?.name;
}

function nextTab(tab: Tab, dir: 1 | -1): Tab {
  const i = TABS.indexOf(tab);
  const n = (i + dir + TABS.length) % TABS.length;
  return TABS[n] ?? "summary";
}

/**
 * Fold a key into the navigation state. Movement keys break follow-active and pin the selection;
 * `.` restores follow-active. Returns the same object when a key is not a navigation key, so callers
 * can detect "handled" by identity if they wish.
 */
export function navOnKey(nav: NavState, key: KeyLike, view: ViewState): NavState {
  const count = view.steps.length;
  const current = effectiveIndex(nav, view);
  switch (key.name) {
    case "j":
    case "down":
      return {
        ...nav,
        followActive: false,
        selectedIndex: Math.min(current + 1, Math.max(0, count - 1)),
      };
    case "k":
    case "up":
      return { ...nav, followActive: false, selectedIndex: Math.max(current - 1, 0) };
    case ".":
      return { ...nav, followActive: true };
    case "tab":
      return { ...nav, tab: nextTab(nav.tab, key.shift ? -1 : 1) };
    case "?":
      return { ...nav, showHelp: !nav.showHelp };
    case "return":
    case "enter":
      return { ...nav, expanded: !nav.expanded };
    default:
      return nav;
  }
}
