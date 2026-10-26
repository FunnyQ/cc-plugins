type Stub = Record<string, any>;
const g = globalThis as Stub;
const appPath = `${import.meta.dir}/../dashboard/dist/app.js`;
const UUID = "11111111-2222-3333-4444-555555555555";
const STUBBED =
  /dashboard\/dist\/modules\/(transcript|decision-log|starfield|lead|permission-modal)\.js$/;
const INITS: Record<string, string> = {
  transcript: "initTranscript",
  "decision-log": "initDecisionLog",
  starfield: "initStarfield",
  lead: "initLead",
  "permission-modal": "initPermissionModal",
};

Bun.plugin({
  name: "stub-column-modules",
  setup(build) {
    build.onLoad({ filter: STUBBED }, (args) => {
      const name = args.path.match(STUBBED)![1]!;
      return {
        contents: `export const ${INITS[name]} = () => undefined;`,
        loader: "js",
      };
    });
  },
});

const json = (body: unknown) => new Response(JSON.stringify(body));
const tick = () => new Promise((r) => setTimeout(r, 0));

type Boot = {
  search?: string;
  sessions?: Stub[];
  design?: (project: string) => Promise<Response> | Response;
};

async function boot({ search = "", sessions = [], design }: Boot = {}) {
  const timeouts: Array<{ fn: () => void; ms: number }> = [];
  const probed: string[] = [];
  g.location = { search };
  g.document = {
    hidden: false,
    currentScript: null,
    addEventListener() {},
    querySelector: (sel: string) =>
      sel === '[data-column="design-system"]' ? {} : null,
  };
  g.window = {
    setTimeout: (fn: () => void, ms: number) => timeouts.push({ fn, ms }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
  };
  g.setInterval = () => 0;
  g.clearInterval = () => {};
  g.fetch = async (url: string) => {
    if (url.startsWith("/api/design-system")) {
      const project = new URL(url, "http://x").searchParams.get("project")!;
      probed.push(project);
      return design ? design(project) : new Response("", { status: 404 });
    }
    if (url === "/api/sessions") return json({ sessions });
    if (url === "/api/projects") return json({ projects: [] });
    return json({});
  };
  const mod = await import(appPath);
  return { store: mod.store as Stub, timeouts, probed };
}

const top = { sessionId: "top", provider: "claude", project: "/t" };

const scenarios: Record<string, () => Promise<unknown>> = {
  async staleProbe() {
    let finishA!: (r: Response) => void;
    const { store } = await boot({
      design: (p) =>
        p === "/a"
          ? new Promise<Response>((r) => (finishA = r))
          : new Response("", { status: 404 }),
    });
    store.selectedProject = "/a";
    const slow = store.refreshDesignAvailability();
    store.selectedProject = "/b";
    await store.refreshDesignAvailability();
    const beforeSlowLands = store.designDocAvailable;
    finishA(json({ tokens: [] }));
    await slow;
    return { beforeSlowLands, afterSlowLands: store.designDocAvailable };
  },
  async initialProbe() {
    const { store, probed } = await boot({
      search: `?session=${UUID}&project=/deep`,
      design: () => json({ tokens: [] }),
    });
    await tick();
    return { probed, available: store.designDocAvailable };
  },
  async subscriberProbe() {
    const { store, probed } = await boot({ design: () => json({}) });
    store.selectSession({ sessionId: UUID, project: "/next" });
    await tick();
    return { probed, available: store.designDocAvailable };
  },
  async deepLink() {
    const { store } = await boot({
      search: `?session=${UUID}&project=/deep`,
      sessions: [top],
    });
    return {
      id: store.selectedSessionId,
      provider: store.selectedProvider,
      project: store.selectedProject,
    };
  },
  async noDeepLink() {
    const { store } = await boot({ sessions: [top] });
    return { id: store.selectedSessionId };
  },
  async untracked() {
    const { store } = await boot({
      search: `?session=${UUID}`,
      sessions: [top],
    });
    return {
      session: store.selectedSession,
      id: store.selectedSessionId,
      title: store.channelDisabledTitle,
    };
  },
  async heroTimeout() {
    const { store, timeouts } = await boot();
    const auto = timeouts.find((t) => t.ms === 60_000)!;
    store.awaitingCall = true;
    auto.fn();
    const whileAwaiting = store.heroCollapsed;
    store.awaitingCall = false;
    auto.fn();
    return { whileAwaiting, afterAnswer: store.heroCollapsed };
  },
};

console.log(JSON.stringify(await scenarios[process.argv[2]!]!()));
process.exit(0);
