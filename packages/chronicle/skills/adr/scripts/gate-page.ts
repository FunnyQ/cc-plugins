#!/usr/bin/env bun
/**
 * Renders the ADR skill's two human gates as a self-contained local HTML page.
 *
 * The page is fixed. The main agent supplies data, never markup and never
 * styling — a gate rendered from scratch each run drifts in layout, in wording,
 * and in which consistency checks it actually enforces.
 *
 * By default the page is self-contained. `--serve` gives it a one-shot
 * loopback endpoint so the response can return without leaving the machine.
 *
 *   bun gate-page.ts --data <payload.json> --open [--serve] [--timeout <seconds>]
 *     [--out <file.html>] [--lang zh-TW]
 *
 * The payload's own `gate` field picks the gate; `--gate` overrides it. Prints
 * the written path on stdout. In serve mode, the response follows it on stdout.
 * Exit `0` means submitted, `2` means bad usage, `3` means no browser, and `4`
 * means the one-shot server timed out.
 */

export type Disposition = "promote" | "watch" | "skip";
export type Lang = "en" | "zh-TW";

export type Gate1Candidate = {
  entryIds: string[];
  title: string;
  reason: string;
  disposition: Disposition;
  matchesAdr?: string | null;
  hint?: string;
};

export type Gate1Conflict = {
  entryIds: string[];
  note: string;
};

export type Gate1Payload = {
  gate: 1;
  lang?: Lang;
  nextAdr: number;
  candidates: Gate1Candidate[];
  conflicts?: Gate1Conflict[];
  scan?: {
    sessions?: number;
    entries?: number;
    clusters?: number;
    conflicts?: number;
    tooFresh?: number;
  };
};

export type Gate2Draft = {
  groupId: string;
  adrNumber: number;
  proposedPath: string;
  draftText: string;
};

export type Gate2Payload = {
  gate: 2;
  lang?: Lang;
  drafts: Gate2Draft[];
};

export type GatePayload = Gate1Payload | Gate2Payload;

/** At most this many records may reach `draft` in one run. */
export const GROUP_CAP = 12;

export type GateServer = {
  url: string;
  port: number;
  submitUrl: string;
  response: Promise<unknown | null>;
  stop: () => void;
};

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function serveGatePage(opts: {
  render: (submitUrl: string) => string;
  nonce?: string;
  timeoutMs?: number;
}): GateServer {
  const nonce = opts.nonce ?? crypto.randomUUID();
  let settle!: (value: unknown | null) => void;
  let settled = false;
  let submitting = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const response = new Promise<unknown | null>((resolve) => {
    settle = resolve;
  });
  const finish = (value: unknown | null) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    settle(value);
  };

  let html = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === `/${nonce}`) {
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      if (request.method !== "POST" || url.pathname !== `/${nonce}/submit`) {
        return new Response(null, { status: 404 });
      }
      if (settled || submitting) return new Response(null, { status: 404 });

      const declaredSize = Number(request.headers.get("content-length"));
      if (declaredSize > MAX_BODY_BYTES)
        return new Response(null, { status: 413 });

      submitting = true;
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > MAX_BODY_BYTES) {
        submitting = false;
        return new Response(null, { status: 413 });
      }

      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        submitting = false;
        return new Response(null, { status: 400 });
      }

      finish(body);
      void server.stop();
      return Response.json({ ok: true });
    },
  });
  const port = server.port;
  const url = `http://127.0.0.1:${port}/${nonce}`;
  const submitUrl = `${url}/submit`;
  html = opts.render(submitUrl);
  timeout = setTimeout(
    () => {
      finish(null);
      void server.stop();
    },
    opts.timeoutMs ?? 30 * 60_000,
  );

  return {
    url,
    port,
    submitUrl,
    response,
    stop: () => {
      finish(null);
      void server.stop();
    },
  };
}

/**
 * Both locales share one shape. Without the annotation `as const` would give
 * each table its own literal types, and the zh-TW table would stop being
 * assignable wherever a renderer takes the en one.
 */
type Strings = {
  eyebrow: string;
  gate1Title: string;
  gate2Title: string;
  gate1Lede: string;
  gate2Lede: string;
  sessions: string;
  entries: string;
  clusters: string;
  conflictsCount: string;
  nextAdr: string;
  tooFresh: string;
  tallyGroups: string;
  cap: string;
  capWillWrite: string;
  capOver: (n: number) => string;
  capNone: string;
  ledgerSect: string;
  draftsSect: string;
  conflictsSect: string;
  conflictsNone: string;
  groupLabel: string;
  groupHint: string;
  moreIds: (n: number) => string;
  matches: string;
  responseSect: string;
  copy: string;
  copied: string;
  send: string;
  sent: string;
  sendFailed: string;
  completeNote: string;
  alertGroupTitle: string;
  alertGroupBody: string;
  alertCapTitle: (n: number) => string;
  alertCapBody: string;
  path: string;
  editToggle: string;
  editNote: string;
  allDropped: string;
};

const STRINGS: Record<Lang, Strings> = {
  en: {
    eyebrow: "chronicle · adr · triage",
    gate1Title: "Gate 1 — confirm the dispositions",
    gate2Title: "Gate 2 — approve the drafts",
    gate1Lede:
      "The reckoner clustered the decision trail by decision and proposed a disposition for each cluster. Override anything below, then copy the response block back into chat. Nothing is written yet — this run is still read-only.",
    gate2Lede:
      "Read each record in full before it is written. Approve the ones that should land, drop the ones that should wait. A dropped record is deferred, not discarded: its candidates return to the watched bucket and re-queue on the next triage run.",
    sessions: "sessions scanned",
    entries: "trail entries",
    clusters: "candidate clusters",
    conflictsCount: "conflicts",
    nextAdr: "next record",
    tooFresh: "sessions held back as too fresh",
    tallyGroups: "records after grouping",
    cap: "cap",
    capWillWrite: "will write",
    capOver: (n: number) =>
      `${n} / ${GROUP_CAP} — over cap, group further or set the excess to watch`,
    capNone: "no promotions — this run records nothing",
    ledgerSect: "Candidate ledger",
    draftsSect: "Proposed records",
    conflictsSect: "Conflicts",
    conflictsNone:
      "The reckoner found no conflicting evidence in this trail, so conflictResolutions stays empty. Nothing to resolve here.",
    groupLabel: "group",
    groupHint: "Rows sharing a group value fold into one record.",
    moreIds: (n: number) => `${n} more`,
    matches: "duplicates",
    responseSect: "Response block",
    copy: "Copy for chat",
    copied: "Copied",
    send: "Send to the agent",
    sent: "Sent — you can close this tab",
    sendFailed: "Send failed — use the copy button",
    completeNote:
      "This carries the complete set, not only the rows you changed. A partial reply cannot say which rows it leaves untouched.",
    alertGroupTitle: "A group holds a non-promote row.",
    alertGroupBody:
      "Rows only fold into one record when every one of them is promote. Either drop the label from the outlier, or set it back to promote.",
    alertCapTitle: (n: number) =>
      `${n} records exceeds the ${GROUP_CAP}-record cap.`,
    alertCapBody:
      "Group further, or set the excess to watch — a watch candidate archives to the watched bucket and re-queues on the next triage run, so nothing is lost.",
    path: "path",
    editToggle: "Edit this text",
    editNote: "Your edit replaces the codifier's text for this record.",
    allDropped:
      "Every record is dropped. This run will promote nothing, and the response omits newAdrs entirely.",
  },
  "zh-TW": {
    eyebrow: "chronicle · adr · triage",
    gate1Title: "Gate 1 — 確認處置",
    gate2Title: "Gate 2 — 確認草稿",
    gate1Lede:
      "reckoner 已把決策軌跡依「決定」分群，並替每一群提出處置。你可以在下面覆寫任何一列，再把回應區塊複製回對話。目前尚未寫入任何檔案，這一輪仍是唯讀的。",
    gate2Lede:
      "寫入之前先把每一筆記錄讀完。該落地的按 approve，該等的按 drop。被 drop 的記錄是延後、不是丟棄：它的候選會回到 watched bucket，下一次分流重新排隊。",
    sessions: "個 session 掃過",
    entries: "筆軌跡項目",
    clusters: "個候選叢集",
    conflictsCount: "個衝突",
    nextAdr: "下一號",
    tooFresh: "個 session 因過新而保留",
    tallyGroups: "分群後記錄數",
    cap: "上限",
    capWillWrite: "將產生",
    capOver: (n: number) =>
      `${n} / ${GROUP_CAP} — 超過上限，請再分群或把多的改成 watch`,
    capNone: "沒有任何晉升 — 這一輪不會產生記錄",
    ledgerSect: "候選帳冊",
    draftsSect: "待寫入的記錄",
    conflictsSect: "衝突",
    conflictsNone:
      "reckoner 在這批軌跡中沒有找到互相牴觸的證據，因此 conflictResolutions 維持空陣列。這裡沒有需要你裁決的事。",
    groupLabel: "group",
    groupHint: "填相同 group 值的列會折成同一筆記錄。",
    moreIds: (n: number) => `另外 ${n} 筆`,
    matches: "重複於",
    responseSect: "回應區塊",
    copy: "複製給對話",
    copied: "已複製",
    send: "送回代理",
    sent: "已送出，可以關掉這個分頁",
    sendFailed: "送出失敗，請改用複製按鈕",
    completeNote:
      "這份回應帶著完整的清單，不只你改過的那幾列。只回傳一部分，會讓「其餘維持原判」變成無法確認的事。",
    alertGroupTitle: "group 裡混進了非 promote 的列。",
    alertGroupBody:
      "只有全部都是 promote 的列才能折成同一筆記錄。要嘛把標籤從那個例外身上拿掉，要嘛把它改回 promote。",
    alertCapTitle: (n: number) => `${n} 筆記錄超過 ${GROUP_CAP} 筆上限。`,
    alertCapBody:
      "請再分群，或把多出來的改成 watch——watch 候選會歸檔到 watched bucket，下一次分流會重新排隊，不會遺失。",
    path: "路徑",
    editToggle: "編輯這段文字",
    editNote: "你的編輯會取代 codifier 對這筆記錄的原文。",
    allDropped:
      "所有記錄都被 drop。這一輪不會晉升任何東西，回應也會完全省略 newAdrs。",
  },
};

const esc = (s: string): string =>
  String(s).replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );

const pad4 = (n: number): string => String(n).padStart(4, "0");

export function renderGatePage(
  payload: GatePayload,
  opts?: { submitUrl?: string },
): string {
  const lang: Lang = payload.lang === "zh-TW" ? "zh-TW" : "en";
  const t = STRINGS[lang];

  if (payload.gate === 1)
    return shell(t.gate1Title, t, payload, gate1Body(payload, t), opts);
  if (payload.gate === 2)
    return shell(t.gate2Title, t, payload, gate2Body(payload, t), opts);
  throw new Error(
    `gate-page: unsupported gate ${(payload as { gate: unknown }).gate}`,
  );
}

function shell(
  title: string,
  t: Strings,
  payload: GatePayload,
  body: string,
  opts?: { submitUrl?: string },
): string {
  // "<" is escaped so a "</script>" inside any title or draft body cannot close
  // this block early and blank the page.
  const data = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<title>${esc(title)}</title>
<style>${CSS}</style>
<script type="application/json" id="payload">${data}</script>
<div class="wrap">
  <header class="masthead">
    <div class="eyebrow">${esc(t.eyebrow)}</div>
    <h1>${esc(title)}</h1>
    <p class="lede">${esc(payload.gate === 1 ? t.gate1Lede : t.gate2Lede)}</p>
${body}
  <section>
    <div class="out-head">
      <div class="sect">${esc(t.responseSect)}</div>
      <button class="btn" id="copy" type="button">${esc(t.copy)}</button>
      <span class="copied" id="copied" hidden>${esc(t.copied)}</span>
${opts?.submitUrl ? `      <button class="btn" id="send" type="button">${esc(t.send)}</button>\n      <span class="copied" id="sent" hidden>${esc(t.sent)}</span>\n` : ""}    </div>
    <p class="quiet-panel">${esc(t.completeNote)}</p>
    <pre id="out"></pre>
  </section>
</div>
<script>${clientScript(payload.gate, opts?.submitUrl)}</script>`;
}

/* ------------------------------ gate 1 ------------------------------ */

function gate1Body(p: Gate1Payload, t: Strings): string {
  const s = p.scan ?? {};
  const facts = [
    s.sessions !== undefined
      ? `<span><b>${s.sessions}</b> ${esc(t.sessions)}</span>`
      : "",
    s.entries !== undefined
      ? `<span><b>${s.entries}</b> ${esc(t.entries)}</span>`
      : "",
    s.clusters !== undefined
      ? `<span><b>${s.clusters}</b> ${esc(t.clusters)}</span>`
      : "",
    s.conflicts !== undefined
      ? `<span><b>${s.conflicts}</b> ${esc(t.conflictsCount)}</span>`
      : "",
    `<span>${esc(t.nextAdr)} <b>ADR-${pad4(p.nextAdr)}</b></span>`,
    s.tooFresh !== undefined
      ? `<span><b>${s.tooFresh}</b> ${esc(t.tooFresh)}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("\n      ");

  const rows = p.candidates
    .map((c, i) => {
      const ids = idMarkup(c.entryIds, t);
      const match = c.matchesAdr
        ? `<span class="match">${esc(t.matches)} <code>${esc(c.matchesAdr)}</code></span>`
        : "";
      const hint = c.hint ? `<p class="hint">${esc(c.hint)}</p>` : "";
      const stamps = (["promote", "watch", "skip"] as const)
        .map(
          (v) =>
            `<input type="radio" name="d${i}" id="d${i}-${v}" value="${v}"${c.disposition === v ? " checked" : ""}>` +
            `<label for="d${i}-${v}" data-v="${v}">${v}</label>`,
        )
        .join("");
      return `      <article class="row" data-d="${esc(c.disposition)}" data-i="${i}">
        <div class="row-main">
          <h2 class="row-title">${esc(c.title)}</h2>
          <p class="row-reason">${esc(c.reason)}</p>
          <div class="row-meta">${ids}${match}</div>
          ${hint}
        </div>
        <div class="row-controls">
          <div class="stamps" role="radiogroup" aria-label="${esc(c.title)}">${stamps}</div>
          <label class="group-field">
            <span>${esc(t.groupLabel)}</span>
            <input type="text" data-group="${i}" placeholder="—" autocomplete="off" spellcheck="false">
          </label>
        </div>
      </article>`;
    })
    .join("\n");

  const conflicts = (p.conflicts ?? []).length
    ? `<div class="ledger">${(p.conflicts ?? [])
        .map(
          (c) =>
            `<article class="row is-conflicted"><div class="row-main"><p class="row-reason">${esc(c.note)}</p><div class="row-meta">${idMarkup(c.entryIds, t)}</div></div></article>`,
        )
        .join("")}</div>`
    : `<div class="quiet-panel">${esc(t.conflictsNone)}</div>`;

  return `    <div class="scanfacts">
      ${facts}
    </div>
  </header>

  <div class="tally">
    <div class="tally-item is-promote"><span class="tally-n" id="n-promote">0</span><span class="tally-l">promote</span></div>
    <div class="tally-item is-watch"><span class="tally-n" id="n-watch">0</span><span class="tally-l">watch</span></div>
    <div class="tally-item is-skip"><span class="tally-n" id="n-skip">0</span><span class="tally-l">skip</span></div>
    <div class="tally-rule"></div>
    <div class="tally-item"><span class="tally-n" id="n-groups">0</span><span class="tally-l">${esc(t.tallyGroups)}</span></div>
    <div class="tally-note" id="cap-note"></div>
  </div>

  <div id="alerts"></div>

  <section>
    <div class="sect">${esc(t.ledgerSect)} <em class="sect-note">${esc(t.groupHint)}</em></div>
    <div class="ledger" id="ledger">
${rows}
    </div>
  </section>

  <section>
    <div class="sect">${esc(t.conflictsSect)}</div>
    ${conflicts}
  </section>
`;
}

function idMarkup(ids: string[], t: Strings): string {
  const shown = ids
    .slice(0, 4)
    .map((i) => `<span class="id">${esc(i)}</span>`)
    .join("");
  if (ids.length <= 4) return shown;
  const rest = ids
    .slice(4)
    .map((i) => `<span class="id" hidden>${esc(i)}</span>`)
    .join("");
  return `${shown}${rest}<button class="more-ids" type="button" data-more>${esc(t.moreIds(ids.length - 4))}</button>`;
}

/* ------------------------------ gate 2 ------------------------------ */

function gate2Body(p: Gate2Payload, t: Strings): string {
  const cards = p.drafts
    .map((d, i) => {
      const stamps = (["approve", "drop"] as const)
        .map(
          (v) =>
            `<input type="radio" name="v${i}" id="v${i}-${v}" value="${v}"${v === "approve" ? " checked" : ""}>` +
            `<label for="v${i}-${v}" data-v="${v}">${v}</label>`,
        )
        .join("");
      return `      <article class="row draft" data-v="approve" data-i="${i}">
        <div class="draft-head">
          <div class="draft-id">
            <span class="record-no">ADR-${pad4(d.adrNumber)}</span>
            <span class="group-no">${esc(d.groupId)}</span>
          </div>
          <div class="stamps" role="radiogroup" aria-label="ADR-${pad4(d.adrNumber)}">${stamps}</div>
        </div>
        <div class="path"><span>${esc(t.path)}</span><code>${esc(d.proposedPath)}</code></div>
        <pre class="draft-text">${esc(d.draftText)}</pre>
        <details class="editor">
          <summary>${esc(t.editToggle)}</summary>
          <p class="hint">${esc(t.editNote)}</p>
          <textarea data-edit="${i}" spellcheck="false" rows="18">${esc(d.draftText)}</textarea>
        </details>
      </article>`;
    })
    .join("\n");

  return `  </header>

  <div class="tally">
    <div class="tally-item is-promote"><span class="tally-n" id="n-approve">0</span><span class="tally-l">approve</span></div>
    <div class="tally-item is-watch"><span class="tally-n" id="n-drop">0</span><span class="tally-l">drop</span></div>
    <div class="tally-rule"></div>
    <div class="tally-note" id="cap-note"></div>
  </div>

  <div id="alerts"></div>

  <section>
    <div class="sect">${esc(t.draftsSect)}</div>
    <div class="ledger" id="ledger">
${cards}
    </div>
  </section>
`;
}

/* ------------------------------ client ------------------------------ */

const SHARED_JS = `
  const P = JSON.parse(document.getElementById("payload").textContent);
  const T = __CLIENT_STRINGS__[P.lang === "zh-TW" ? "zh-TW" : "en"];
  const pad4 = n => String(n).padStart(4, "0");
  const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const out = document.getElementById("out");
  const copyBtn = document.getElementById("copy");

__SEND_BUTTON_REF__  copyBtn.addEventListener("click", async () => {
    const text = out.textContent;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    const flag = document.getElementById("copied");
    flag.hidden = false;
    setTimeout(() => { flag.hidden = true; }, 1800);
  });

__SUBMIT_HANDLER__  document.getElementById("ledger").addEventListener("click", e => {
    const btn = e.target.closest("[data-more]");
    if (!btn) return;
    btn.parentElement.querySelectorAll(".id[hidden]").forEach(el => { el.hidden = false; });
    btn.remove();
  });
`;

function clientScript(gate: 1 | 2, submitUrl?: string): string {
  const submitHandler = submitUrl
    ? `  const submitUrl = ${JSON.stringify(submitUrl).replace(/</g, "\\u003c")};
  sendBtn.addEventListener("click", async () => {
    const flag = document.getElementById("sent");
    try {
      const response = await fetch(submitUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: out.textContent,
      });
      if (!response.ok) throw new Error(String(response.status));
      flag.textContent = T.sent;
      flag.hidden = false;
      sendBtn.disabled = true;
    } catch {
      flag.textContent = T.sendFailed;
      flag.hidden = false;
      sendBtn.disabled = false;
    }
  });

`
    : "";
  // Every replacement goes through a function, never a string. A string
  // replacement re-reads `$&` and friends as substitution patterns, and
  // `submitUrl` is caller-supplied — one carrying `$&` would splice the
  // placeholder's own text back into the emitted script.
  const fill = (source: string, token: string, value: string): string =>
    source.replace(token, () => value);

  return [
    [
      "__CLIENT_STRINGS__",
      JSON.stringify({
        en: pickClientStrings("en", Boolean(submitUrl)),
        "zh-TW": pickClientStrings("zh-TW", Boolean(submitUrl)),
      }),
    ],
    [
      "__SEND_BUTTON_REF__",
      submitUrl ? '  const sendBtn = document.getElementById("send");\n\n' : "",
    ],
    ["__SUBMIT_HANDLER__", submitHandler],
    [
      "__DISABLE_BUTTONS__",
      submitUrl
        ? "    const disabled = bad.length > 0 || groups.length > CAP;\n    copyBtn.disabled = disabled;\n    if (sendBtn) sendBtn.disabled = disabled;"
        : "    copyBtn.disabled = bad.length > 0 || groups.length > CAP;",
    ],
  ].reduce(
    (script, [token, value]) => fill(script, token, value),
    gate === 1 ? GATE1_JS : GATE2_JS,
  );
}

const GATE1_JS = `(() => {
${SHARED_JS}
  const CAP = ${GROUP_CAP};
  const state = P.candidates.map(c => ({ d: c.disposition, group: "" }));

  document.getElementById("ledger").addEventListener("change", e => {
    const radio = e.target.closest('input[type="radio"]');
    if (!radio) return;
    const row = radio.closest(".row");
    state[Number(row.dataset.i)].d = radio.value;
    row.dataset.d = radio.value;
    render();
  });

  document.getElementById("ledger").addEventListener("input", e => {
    const gi = e.target.dataset.group;
    if (gi === undefined) return;
    state[Number(gi)].group = e.target.value.trim();
    render();
  });

  function groupsOf() {
    const order = [], seen = new Map();
    state.forEach((s, i) => {
      if (s.d !== "promote") return;
      const key = s.group || "__solo_" + i;
      if (!seen.has(key)) { seen.set(key, []); order.push(key); }
      seen.get(key).push(i);
    });
    return order.map(k => seen.get(k));
  }

  function contradictions() {
    const byLabel = new Map();
    state.forEach((s, i) => {
      if (!s.group) return;
      if (!byLabel.has(s.group)) byLabel.set(s.group, []);
      byLabel.get(s.group).push(i);
    });
    const bad = [];
    byLabel.forEach((rows, label) => {
      const offenders = rows.filter(i => state[i].d !== "promote");
      if (offenders.length) bad.push({ label, offenders });
    });
    return bad;
  }

  function render() {
    const counts = { promote: 0, watch: 0, skip: 0 };
    state.forEach(s => counts[s.d]++);
    document.getElementById("n-promote").textContent = counts.promote;
    document.getElementById("n-watch").textContent = counts.watch;
    document.getElementById("n-skip").textContent = counts.skip;

    const groups = groupsOf();
    document.getElementById("n-groups").textContent = groups.length;

    const cap = document.getElementById("cap-note");
    if (groups.length > CAP) {
      cap.textContent = T.capOver.replace("{n}", groups.length);
      cap.classList.add("is-over");
    } else if (groups.length === 0) {
      cap.textContent = T.capNone;
      cap.classList.remove("is-over");
    } else {
      const last = P.nextAdr + groups.length - 1;
      cap.innerHTML = T.cap + " " + CAP + " · " + T.capWillWrite +
        " <code>ADR-" + pad4(P.nextAdr) + (groups.length > 1 ? "</code>–<code>ADR-" + pad4(last) : "") + "</code>";
      cap.classList.remove("is-over");
    }

    const bad = contradictions();
    document.querySelectorAll(".row").forEach(r => r.classList.remove("is-conflicted"));
    bad.forEach(b => b.offenders.forEach(i => {
      document.querySelector('.row[data-i="' + i + '"]').classList.add("is-conflicted");
    }));

    const items = [];
    if (bad.length) {
      items.push('<div class="alert"><b>' + esc(T.alertGroupTitle) + "</b><span>" +
        bad.map(b => "<code>" + esc(b.label) + "</code>").join("、") + " — " + esc(T.alertGroupBody) + "</span></div>");
    }
    if (groups.length > CAP) {
      items.push('<div class="alert"><b>' + esc(T.alertCapTitle.replace("{n}", groups.length)) +
        "</b><span>" + esc(T.alertCapBody) + "</span></div>");
    }
    document.getElementById("alerts").innerHTML = items.join("");

    out.textContent = JSON.stringify({
      dispositions: state.map((s, i) => {
        const row = { entryIds: P.candidates[i].entryIds, decision: s.d };
        if (s.group && s.d === "promote") row.group = s.group;
        return row;
      }),
      conflictResolutions: (P.conflicts || []).map(c => ({ entryIds: c.entryIds, resolution: "skip" })),
    }, null, 2);

__DISABLE_BUTTONS__
  }

  render();
})();`;

const GATE2_JS = `(() => {
${SHARED_JS}
  const state = P.drafts.map(d => ({ v: "approve", text: d.draftText }));

  document.getElementById("ledger").addEventListener("change", e => {
    const radio = e.target.closest('input[type="radio"]');
    if (!radio) return;
    const row = radio.closest(".row");
    state[Number(row.dataset.i)].v = radio.value;
    row.dataset.v = radio.value;
    render();
  });

  document.getElementById("ledger").addEventListener("input", e => {
    const ei = e.target.dataset.edit;
    if (ei === undefined) return;
    state[Number(ei)].text = e.target.value;
    render();
  });

  function render() {
    const approved = state.filter(s => s.v === "approve").length;
    document.getElementById("n-approve").textContent = approved;
    document.getElementById("n-drop").textContent = state.length - approved;

    const cap = document.getElementById("cap-note");
    cap.textContent = approved === 0 ? T.capNone : "";

    document.getElementById("alerts").innerHTML = approved === 0
      ? '<div class="alert"><b>' + esc(T.allDropped) + "</b></div>"
      : "";

    out.textContent = JSON.stringify({
      verdicts: P.drafts.map((d, i) => {
        const row = { proposedPath: d.proposedPath, verdict: state[i].v };
        if (state[i].v === "approve" && state[i].text !== d.draftText) row.draftText = state[i].text;
        return row;
      }),
    }, null, 2);
  }

  render();
})();`;

function pickClientStrings(lang: Lang, withSubmit = false) {
  const t = STRINGS[lang];
  return {
    cap: t.cap,
    capWillWrite: t.capWillWrite,
    capOver: t.capOver(0).replace("0 /", "{n} /"),
    capNone: t.capNone,
    alertGroupTitle: t.alertGroupTitle,
    alertGroupBody: t.alertGroupBody,
    alertCapTitle: t.alertCapTitle(0).replace(/^0/, "{n}"),
    alertCapBody: t.alertCapBody,
    allDropped: t.allDropped,
    ...(withSubmit
      ? { send: t.send, sent: t.sent, sendFailed: t.sendFailed }
      : {}),
  };
}

/* -------------------------------- css -------------------------------- */

const CSS = `
:root {
  --paper: #eceef1; --card: #fff; --ink: #171a20; --ink-2: #4a5262; --ink-3: #7c8496;
  --line: #d6dae1; --line-strong: #b9c0cb;
  --promote: #1c6b57; --promote-bg: #e2efea;
  --watch: #8f5c0d; --watch-bg: #f6ecda;
  --skip: #6b7280; --skip-bg: #e9ebef;
  --accent: #2a4a8c; --warn: #a3341f; --warn-bg: #f8e6e1;
  --shadow: 0 1px 2px rgba(23,26,32,.06), 0 6px 16px -10px rgba(23,26,32,.18);
  --f-title: Georgia, "Iowan Old Style", "Songti TC", "Source Han Serif TC", "Noto Serif TC", serif;
  --f-ui: ui-sans-serif, -apple-system, "PingFang TC", "Segoe UI", "Noto Sans TC", sans-serif;
  --f-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #101319; --card: #171b22; --ink: #e6e9ef; --ink-2: #a5adbd; --ink-3: #767f92;
    --line: #272d38; --line-strong: #3a4250;
    --promote: #5fc0a3; --promote-bg: #16302a;
    --watch: #d9a441; --watch-bg: #332715;
    --skip: #8b93a3; --skip-bg: #222731;
    --accent: #7f9de0; --warn: #e08a76; --warn-bg: #3a201a;
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 6px 16px -10px rgba(0,0,0,.7);
  }
}
:root[data-theme="light"] {
  --paper: #eceef1; --card: #fff; --ink: #171a20; --ink-2: #4a5262; --ink-3: #7c8496;
  --line: #d6dae1; --line-strong: #b9c0cb;
  --promote: #1c6b57; --promote-bg: #e2efea;
  --watch: #8f5c0d; --watch-bg: #f6ecda;
  --skip: #6b7280; --skip-bg: #e9ebef;
  --accent: #2a4a8c; --warn: #a3341f; --warn-bg: #f8e6e1;
  --shadow: 0 1px 2px rgba(23,26,32,.06), 0 6px 16px -10px rgba(23,26,32,.18);
}
:root[data-theme="dark"] {
  --paper: #101319; --card: #171b22; --ink: #e6e9ef; --ink-2: #a5adbd; --ink-3: #767f92;
  --line: #272d38; --line-strong: #3a4250;
  --promote: #5fc0a3; --promote-bg: #16302a;
  --watch: #d9a441; --watch-bg: #332715;
  --skip: #8b93a3; --skip-bg: #222731;
  --accent: #7f9de0; --warn: #e08a76; --warn-bg: #3a201a;
  --shadow: 0 1px 2px rgba(0,0,0,.4), 0 6px 16px -10px rgba(0,0,0,.7);
}
body { background: var(--paper); color: var(--ink); font-family: var(--f-ui); font-size: 15px; line-height: 1.75; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1080px; margin: 0 auto; padding: 40px 24px 96px; display: flex; flex-direction: column; gap: 28px; }
.masthead { display: flex; flex-direction: column; gap: 10px; }
.eyebrow { font-family: var(--f-mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-3); }
h1 { font-family: var(--f-title); font-size: clamp(27px, 3.8vw, 38px); font-weight: 400; line-height: 1.3; text-wrap: balance; }
.lede { color: var(--ink-2); max-width: 40em; }
.scanfacts { display: flex; flex-wrap: wrap; gap: 4px 20px; padding-top: 8px; margin-top: 4px; border-top: 1px solid var(--line); font-size: 13px; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.scanfacts b { font-weight: 600; color: var(--ink); }
.tally { position: sticky; top: 0; z-index: 20; background: var(--card); border: 1px solid var(--line); border-radius: 3px; box-shadow: var(--shadow); padding: 14px 18px; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 26px; }
.tally-item { display: flex; align-items: baseline; gap: 8px; }
.tally-n { font-family: var(--f-mono); font-size: 20px; line-height: 1; font-variant-numeric: tabular-nums; }
.tally-l { font-size: 12px; letter-spacing: .04em; color: var(--ink-3); }
.tally-item.is-promote .tally-n { color: var(--promote); }
.tally-item.is-watch .tally-n { color: var(--watch); }
.tally-item.is-skip .tally-n { color: var(--skip); }
.tally-rule { width: 1px; align-self: stretch; background: var(--line); }
.tally-note { margin-left: auto; font-size: 12.5px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.tally-note code { font-family: var(--f-mono); }
.tally-note.is-over { color: var(--warn); }
.alert { border: 1px solid var(--warn); background: var(--warn-bg); color: var(--warn); border-radius: 3px; padding: 12px 16px; font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
.alert b { font-weight: 600; }
.alert code { font-family: var(--f-mono); font-size: 13px; }
.sect { font-family: var(--f-mono); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--ink-3); padding-bottom: 8px; margin-bottom: 12px; border-bottom: 1px solid var(--line-strong); display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; }
.sect-note { font-style: normal; font-family: var(--f-ui); font-size: 12px; letter-spacing: 0; text-transform: none; }
.ledger { display: flex; flex-direction: column; gap: 10px; }
.row { background: var(--card); border: 1px solid var(--line); border-radius: 3px; box-shadow: var(--shadow); padding: 16px 18px; display: grid; grid-template-columns: 1fr auto; gap: 12px 24px; align-items: start; }
.row[data-d="promote"], .row[data-v="approve"] { border-color: color-mix(in oklch, var(--promote) 42%, var(--line)); }
.row[data-d="watch"] { border-style: dashed; border-color: color-mix(in oklch, var(--watch) 52%, var(--line)); }
.row[data-d="skip"], .row[data-v="drop"] { background: var(--paper); border-color: var(--line); box-shadow: none; }
.row.is-conflicted { border-style: solid; border-color: var(--warn); background: var(--warn-bg); }
.row-main { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.row-title { font-family: var(--f-title); font-size: 18px; font-weight: 400; line-height: 1.5; text-wrap: balance; }
.row[data-d="skip"] .row-title { color: var(--ink-2); }
.row-reason { font-size: 13.5px; color: var(--ink-2); max-width: 44em; }
.row-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.id { font-family: var(--f-mono); font-size: 11.5px; padding: 2px 6px; border: 1px solid var(--line); border-radius: 2px; color: var(--ink-2); background: var(--paper); }
.row[data-d="skip"] .id { background: var(--card); }
.more-ids { font-family: var(--f-ui); font-size: 12px; background: none; border: 1px dashed var(--line-strong); border-radius: 2px; padding: 2px 8px; color: var(--ink-3); cursor: pointer; }
.more-ids:hover { color: var(--accent); border-color: var(--accent); }
.match { font-size: 12px; padding: 2px 8px; border-radius: 2px; background: var(--skip-bg); color: var(--ink-2); }
.match code { font-family: var(--f-mono); }
.hint { font-size: 12.5px; color: var(--ink-3); border-left: 2px solid var(--line-strong); padding-left: 10px; }
.hint code { font-family: var(--f-mono); color: var(--ink-2); }
.row-controls { display: flex; flex-direction: column; gap: 10px; align-items: flex-end; }
.stamps { display: flex; gap: 6px; }
.stamps input { position: absolute; opacity: 0; pointer-events: none; }
.stamps label { font-family: var(--f-mono); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; font-weight: 600; padding: 5px 11px; border: 1.5px solid transparent; border-radius: 2px; color: var(--ink-3); cursor: pointer; user-select: none; transition: color .12s, border-color .12s, background .12s; }
.stamps label:hover { color: var(--ink); }
.stamps input:focus-visible + label { outline: 2px solid var(--accent); outline-offset: 2px; }
.stamps input:checked + label[data-v="promote"], .stamps input:checked + label[data-v="approve"] { color: var(--promote); border-color: var(--promote); background: var(--promote-bg); }
.stamps input:checked + label[data-v="watch"], .stamps input:checked + label[data-v="drop"] { color: var(--watch); border-color: var(--watch); background: var(--watch-bg); }
.stamps input:checked + label[data-v="skip"] { color: var(--skip); border-color: var(--skip); background: var(--skip-bg); }
.group-field { display: flex; align-items: center; gap: 8px; }
.group-field span { font-family: var(--f-mono); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: var(--ink-3); }
.group-field input { font-family: var(--f-mono); font-size: 13px; width: 96px; padding: 4px 8px; border: 1px solid var(--line-strong); border-radius: 2px; background: var(--paper); color: var(--ink); }
.row[data-d="skip"] .group-field input { background: var(--card); }
.group-field input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.group-field input::placeholder { color: var(--ink-3); }
.row.draft { grid-template-columns: 1fr; gap: 12px; }
.draft-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.draft-id { display: flex; align-items: baseline; gap: 10px; }
.record-no { font-family: var(--f-mono); font-size: 17px; color: var(--ink); }
.group-no { font-family: var(--f-mono); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.path { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; font-size: 12px; color: var(--ink-3); }
.path span { font-family: var(--f-mono); text-transform: uppercase; letter-spacing: .1em; }
.path code { font-family: var(--f-mono); font-size: 12.5px; color: var(--ink-2); word-break: break-all; }
.draft-text { background: var(--paper); border: 1px solid var(--line); border-radius: 3px; padding: 16px 18px; overflow-x: auto; font-family: var(--f-mono); font-size: 12.5px; line-height: 1.65; color: var(--ink); white-space: pre-wrap; }
.row[data-v="drop"] .draft-text { background: var(--card); color: var(--ink-3); }
.editor summary { font-size: 13px; color: var(--accent); cursor: pointer; }
.editor summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.editor textarea { width: 100%; margin-top: 8px; font-family: var(--f-mono); font-size: 12.5px; line-height: 1.65; padding: 12px 14px; border: 1px solid var(--line-strong); border-radius: 3px; background: var(--paper); color: var(--ink); resize: vertical; }
.editor textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.out-head { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
.out-head .sect { border: 0; padding: 0; margin: 0; }
.btn { font-family: var(--f-ui); font-size: 13.5px; font-weight: 600; padding: 8px 18px; border: 1px solid var(--accent); border-radius: 2px; background: var(--accent); color: #fff; cursor: pointer; }
.btn:hover { filter: brightness(1.12); }
.btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.btn[disabled] { opacity: .45; cursor: not-allowed; filter: none; }
.copied { font-size: 13px; color: var(--promote); }
pre#out { background: var(--card); border: 1px solid var(--line); border-radius: 3px; padding: 16px 18px; overflow-x: auto; font-family: var(--f-mono); font-size: 12.5px; line-height: 1.6; color: var(--ink-2); }
.quiet-panel { background: var(--card); border: 1px solid var(--line); border-radius: 3px; padding: 14px 18px; margin: 12px 0; font-size: 13.5px; color: var(--ink-2); }
.quiet-panel code { font-family: var(--f-mono); }
@media (max-width: 720px) { .row { grid-template-columns: 1fr; } .row-controls { align-items: flex-start; } }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

/* -------------------------------- cli -------------------------------- */

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const dataPath = flag("data");
  if (!dataPath) {
    console.error("gate-page: --data <payload.json> is required");
    process.exit(2);
  }

  const payload = (await Bun.file(dataPath).json()) as GatePayload;
  const gateFlag = flag("gate");
  if (gateFlag) payload.gate = Number(gateFlag) as 1 | 2;
  const langFlag = flag("lang");
  if (langFlag) payload.lang = langFlag as Lang;

  const serve = argv.includes("--serve");
  const timeoutFlag = flag("timeout");
  const timeoutSeconds =
    timeoutFlag === undefined ? 30 * 60 : Number(timeoutFlag);
  if (
    (argv.includes("--timeout") && timeoutFlag === undefined) ||
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0
  ) {
    console.error("gate-page: --timeout <seconds> must be a positive number");
    process.exit(2);
  }

  const outPath =
    flag("out") ?? `/tmp/chronicle/adr/gate${payload.gate}-${Date.now()}.html`;
  let pageUrl = outPath;
  let gateServer: GateServer | undefined;
  let html = "";
  if (serve) {
    gateServer = serveGatePage({
      render: (submitUrl) => {
        html = renderGatePage(payload, { submitUrl });
        return html;
      },
      timeoutMs: timeoutSeconds * 1_000,
    });
    pageUrl = gateServer.url;
  } else {
    html = renderGatePage(payload);
  }
  await Bun.write(outPath, html);
  console.log(outPath);
  if (gateServer) console.error(`gate-page: serving ${gateServer.url}`);

  // The review surface stays local whether the browser reads the file or the
  // one-shot loopback page.
  if (argv.includes("--open")) {
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    const proc = Bun.spawn([opener, pageUrl], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await proc.exited) !== 0) {
      gateServer?.stop();
      console.error(
        `gate-page: could not open a browser with "${opener}" — open ${pageUrl} by hand`,
      );
      process.exit(3);
    }
  }

  if (gateServer) {
    const body = await gateServer.response;
    if (body === null) {
      console.error("gate-page: timed out waiting for a response");
      process.exit(4);
    }
    const responseText = JSON.stringify(body, null, 2);
    await Bun.write(`${outPath}.response.json`, responseText);
    console.log(responseText);
  }
}
