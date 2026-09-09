import { createRootRoute, createRoute, createRouter, redirect } from "@tanstack/react-router";
import { RootLayout } from "./frame/Frame";
import { AiLogsPage } from "./pages/AiLogs";
import { InboxPage } from "./pages/Inbox";
import { CompaniesPage } from "./pages/Companies";
import { CompanyPage } from "./pages/Company";
import { PipelinePage } from "./pages/Pipeline";
import { PositionPage } from "./pages/Position";
import { RadarPage } from "./pages/Radar";
import { SettingsPage } from "./pages/Settings";
import { TodayPage } from "./pages/Today";

const rootRoute = createRootRoute({ component: RootLayout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/today" });
  },
});

const todayRoute = createRoute({ getParentRoute: () => rootRoute, path: "/today", component: TodayPage });

export type PipelineSearch = {
  q?: string;
  status?: string;
  verdict?: string;
  sort?: string;
  page?: number;
  view?: "table" | "board";
  company?: string;
  workplace?: string;
  geoClass?: string;
};
const pipelineRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/pipeline",
  component: PipelinePage,
  validateSearch: (s: Record<string, unknown>): PipelineSearch => ({
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    status: typeof s.status === "string" && s.status ? s.status : undefined,
    verdict: typeof s.verdict === "string" && s.verdict ? s.verdict : undefined,
    sort: typeof s.sort === "string" && s.sort ? s.sort : undefined,
    page: typeof s.page === "number" && s.page > 1 ? s.page : undefined,
    view: s.view === "board" ? "board" : undefined,
    company: typeof s.company === "string" && s.company ? s.company : undefined,
    workplace: typeof s.workplace === "string" && s.workplace ? s.workplace : undefined,
    geoClass: typeof s.geoClass === "string" && s.geoClass ? s.geoClass : undefined,
  }),
});

export type RadarSearch = { tab?: "discovery" | "deltas" | "boards" | "watches"; lane?: string; q?: string; page?: number; hours?: number; sort?: string };
const radarSearch = (s: Record<string, unknown>): RadarSearch => ({
  tab: s.tab === "deltas" || s.tab === "boards" || s.tab === "watches" ? s.tab : undefined,
  lane: typeof s.lane === "string" && s.lane ? s.lane : undefined,
  q: typeof s.q === "string" && s.q ? s.q : undefined,
  page: typeof s.page === "number" && s.page > 1 ? s.page : undefined,
  hours: typeof s.hours === "number" && s.hours > 0 ? s.hours : undefined,
  sort: typeof s.sort === "string" && s.sort ? s.sort : undefined,
});
const radarRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/radar",
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/discovery", search: search as RadarSearch });
  },
  validateSearch: radarSearch,
});
const discoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/discovery",
  component: RadarPage,
  validateSearch: radarSearch,
});
const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  component: RadarPage,
  validateSearch: (s: Record<string, unknown>): RadarSearch => ({
    ...radarSearch(s),
    tab: s.tab === "watches" ? "watches" : "boards",
  }),
});

export type PositionSearch = { tab?: string; sort?: string };
const positionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/positions/$id",
  component: PositionPage,
  validateSearch: (s: Record<string, unknown>): PositionSearch => ({
    tab: typeof s.tab === "string" && s.tab ? s.tab : undefined,
    sort: typeof s.sort === "string" && s.sort ? s.sort : undefined,
  }),
});

export type CompaniesSearch = { q?: string; page?: number; all?: boolean; sort?: string };
const companiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/companies",
  component: CompaniesPage,
  validateSearch: (s: Record<string, unknown>): CompaniesSearch => ({
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    page: typeof s.page === "number" && s.page > 1 ? s.page : undefined,
    all: s.all === true ? true : undefined,
    sort: typeof s.sort === "string" && s.sort ? s.sort : undefined,
  }),
});
const companyRoute = createRoute({ getParentRoute: () => rootRoute, path: "/companies/$id", component: CompanyPage });
export type InboxSearch = { sort?: string; status?: string };
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxPage,
  validateSearch: (s: Record<string, unknown>): InboxSearch => ({
    sort: typeof s.sort === "string" && s.sort ? s.sort : undefined,
    status: typeof s.status === "string" && s.status ? s.status : undefined,
  }),
});

export type AiLogsSearch = { operation?: string; status?: string; q?: string; run?: string };
const aiLogsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ai-logs",
  component: AiLogsPage,
  validateSearch: (s: Record<string, unknown>): AiLogsSearch => ({
    operation: typeof s.operation === "string" && s.operation ? s.operation : undefined,
    status: s.status === "ok" || s.status === "error" ? s.status : undefined,
    q: typeof s.q === "string" && s.q ? s.q : undefined,
    run: typeof s.run === "string" && s.run ? s.run : undefined,
  }),
});

export type SettingsSearch = { tab?: "profile" | "gate" | "ai" | "autopilot" | "appearance" | "system" };
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
  validateSearch: (s: Record<string, unknown>): SettingsSearch => ({
    tab: s.tab === "gate" || s.tab === "ai" || s.tab === "autopilot" || s.tab === "appearance" || s.tab === "system" || s.tab === "profile" ? s.tab : undefined,
  }),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  todayRoute,
  pipelineRoute,
  radarRoute,
  discoveryRoute,
  sourcesRoute,
  positionRoute,
  companiesRoute,
  companyRoute,
  inboxRoute,
  aiLogsRoute,
  settingsRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
