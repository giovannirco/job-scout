import { useCallback, useEffect, useSyncExternalStore } from "react";

/* ------------------------------------------------------------ theme */

export type ThemePref = "dark" | "light" | "system";
const THEME_KEY = "js_theme";

function readPref(): ThemePref {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}
function resolve(pref: ThemePref): "dark" | "light" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function apply(pref: ThemePref) {
  const t = resolve(pref);
  document.documentElement.className = t;
}

const themeListeners = new Set<() => void>();
function setThemePref(p: ThemePref) {
  localStorage.setItem(THEME_KEY, p);
  apply(p);
  themeListeners.forEach((l) => l());
}

export function useTheme() {
  const pref = useSyncExternalStore(
    (cb) => {
      themeListeners.add(cb);
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const onMq = () => {
        if (readPref() === "system") apply("system");
        cb();
      };
      mq.addEventListener("change", onMq);
      return () => {
        themeListeners.delete(cb);
        mq.removeEventListener("change", onMq);
      };
    },
    readPref,
    () => "dark" as ThemePref,
  );
  const resolved = resolve(pref);
  const toggle = useCallback(() => setThemePref(resolved === "dark" ? "light" : "dark"), [resolved]);
  return { pref, resolved, set: setThemePref, toggle };
}

/* ------------------------------------------------------------ UI state (dock, sidebar, chat scope) */

export type DockTab = "wire" | "inbox" | "chat";
export type ChatScopeCtx = { scope: "global" } | { scope: "position"; positionId: string; label: string; slug: string } | { scope: "company"; companyId: string; label: string; slug: string };

type UiState = {
  dockOpen: boolean;
  dockTab: DockTab;
  sidebarCollapsed: boolean;
  chatScope: ChatScopeCtx;
  paletteOpen: boolean;
  addOpen: boolean;
};

const UI_KEY = "js_ui";
function loadUi(): UiState {
  let saved: Partial<UiState> = {};
  try {
    saved = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
  } catch {
    /* ignore */
  }
  const wide = window.innerWidth >= 1280;
  return {
    dockOpen: wide && (saved.dockOpen ?? true),
    dockTab: saved.dockTab ?? "wire",
    sidebarCollapsed: saved.sidebarCollapsed ?? false,
    chatScope: { scope: "global" },
    paletteOpen: false,
    addOpen: false,
  };
}

let ui: UiState = typeof window === "undefined" ? ({} as UiState) : loadUi();
const uiListeners = new Set<() => void>();

export function setUi(patch: Partial<UiState> | ((s: UiState) => Partial<UiState>)) {
  const p = typeof patch === "function" ? patch(ui) : patch;
  ui = { ...ui, ...p };
  const { dockTab, sidebarCollapsed } = ui;
  let saved: Partial<UiState> = {};
  try { saved = JSON.parse(localStorage.getItem(UI_KEY) || "{}"); } catch { /* use defaults */ }
  const dockOpen = window.innerWidth >= 1024 ? ui.dockOpen : saved.dockOpen;
  localStorage.setItem(UI_KEY, JSON.stringify({ dockOpen, dockTab, sidebarCollapsed }));
  uiListeners.forEach((l) => l());
}

export function useUi(): UiState {
  return useSyncExternalStore(
    (cb) => {
      uiListeners.add(cb);
      return () => uiListeners.delete(cb);
    },
    () => ui,
    () => ui,
  );
}

export function openDock(tab: DockTab) {
  setUi({ dockOpen: true, dockTab: tab });
}
export function toggleDock(tab?: DockTab) {
  setUi((s) => (tab && s.dockTab !== tab ? { dockOpen: true, dockTab: tab } : { dockOpen: !s.dockOpen, dockTab: tab ?? s.dockTab }));
}

/** Pages declare the chat scope they want while mounted. */
export function useChatScope(scope: ChatScopeCtx | null) {
  const key = scope ? JSON.stringify(scope) : "";
  useEffect(() => {
    if (!scope) return;
    setUi({ chatScope: scope });
    return () => setUi({ chatScope: { scope: "global" } });
    // Scope identity is represented by key; do not reset for a new object reference.
  }, [key]);
}
