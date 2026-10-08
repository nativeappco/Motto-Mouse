const $ = (sel) => document.querySelector(sel);

const views = {
  login: $("#login-view"),
  lookup: $("#lookup-view"),
  settings: $("#settings-view"),
  mapping: $("#mapping-view"),
};
const state = {
  signedIn: false,
  detail: null,
  filter: "",
  hideEmpty: false,
  showAll: false,
  settings: null, // { groups, usingDefaults, updatedAt, updatedBy }
  selection: new Set(), // field ids currently ticked in the settings form
  savedSelection: new Set(),
  settingsFilter: "",
  mapping: null, // { sources, targets, shopify, updatedAt, updatedBy } from /api/mappings
  mappingRows: [], // [{ id, sourceFieldId, target, mode }] being edited
  savedMappingRows: "[]",
  prompts: null, // the PDF prompts from /api/pdf/prompts
  extracts: new Map(), // "recordId:attachmentId:extract" -> { status, markdown?, error? }, kept so redraws don't lose results
};

// ---------- Routing ----------
function currentRoute() {
  const r = location.hash.replace(/^#\/?/, "").split("?")[0];
  return ["settings", "mapping"].includes(r) ? r : "lookup";
}

function show(view) {
  for (const [name, el] of Object.entries(views)) el.hidden = name !== view;
  $("#header-actions").hidden = view === "login";
  for (const link of document.querySelectorAll("[data-nav]")) {
    if (link.dataset.nav === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function route() {
  if (!state.signedIn) return show("login");
  const view = currentRoute();
  show(view);
  if (view === "settings") {
    loadSettings();
    loadPrompt();
  } else if (view === "mapping") loadMapping();
  else $("#lookup-input").focus();
}

// Unsaved settings or mapping edits stay in memory when switching pages, so only warn on unload.
window.addEventListener("hashchange", route);

window.addEventListener("beforeunload", (e) => {
  if (isDirty() || isMappingDirty() || isPromptDirty()) e.preventDefault();
});

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") {
    state.signedIn = false;
    show("login");
    throw new Error("Your session has expired. Please sign in again.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Auth ----------
async function init() {
  try {
    const s = await api("/api/session");
    signedIn(s.username);
  } catch {
    show("login");
    $("#login-form input[name=username]").focus();
  }
}

function signedIn(username) {
  state.signedIn = true;
  $("#header-user").textContent = username;
  route();
  const q = new URLSearchParams(location.hash.split("?")[1] || "").get("q");
  if (q && currentRoute() === "lookup") {
    $("#lookup-input").value = q;
    search(q);
  }
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $("#login-error");
  const button = form.querySelector("button");
  err.hidden = true;
  button.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    const res = await api("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    form.reset();
    signedIn(res.username);
  } catch (error) {
    err.textContent = error.message;
    err.hidden = false;
  } finally {
    button.disabled = false;
  }
});

$("#logout-button").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  state.signedIn = false;
  state.settings = null;
  state.prompts = null;
  state.mapping = null;
  state.mappingRows = [];
  $("#results").replaceChildren();
  $("#detail").replaceChildren();
  $("#lookup-empty").hidden = false;
  setStatus("");
  history.replaceState(null, "", location.pathname);
  show("login");
});

// ---------- Lookup ----------
$("#lookup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("#lookup-input").value.trim();
  if (raw) search(raw);
});

// A pasted spreadsheet column arrives as lines, which a text input would squash; turn it into a comma list.
$("#lookup-input").addEventListener("paste", (e) => {
  const text = e.clipboardData?.getData("text") ?? "";
  if (!/[\r\n\t]/.test(text)) return;
  e.preventDefault();
  const input = e.currentTarget;
  input.setRangeText(parseQueries(text).join(", "), input.selectionStart, input.selectionEnd, "end");
});

function setStatus(text, isError = false) {
  const el = $("#lookup-status");
  el.textContent = text;
  el.classList.toggle("status--error", isError);
}

const MAX_BATCH = 20;

// Splits a comma/semicolon/line separated list into unique lookup values.
function parseQueries(raw) {
  const seen = new Set();
  const out = [];
  for (const part of raw.split(/[,;\t\r\n]+/)) {
    const q = part.trim().replace(/^["']+|["']+$/g, "").trim();
    if (!q || seen.has(q.toUpperCase())) continue;
    seen.add(q.toUpperCase());
    out.push(q);
  }
  return out;
}

// Starting a new search bumps this, which stops any batch still working through its list.
let lookupRun = 0;

function search(raw) {
  const queries = parseQueries(raw);
  if (queries.length === 0) return;
  history.replaceState(null, "", `#/lookup?q=${encodeURIComponent(raw)}`);
  if (queries.length === 1) lookup(queries[0]);
  else lookupBatch(queries);
}

async function lookup(q) {
  const run = ++lookupRun;
  const button = $("#lookup-form button");
  button.disabled = true;
  setStatus("Searching Airtable…");
  $("#lookup-empty").hidden = true;
  $("#results").replaceChildren();
  $("#detail").replaceChildren();
  showSearching(true);
  try {
    const data = await api(`/api/lookup?q=${encodeURIComponent(q)}`);
    if (run !== lookupRun) return;
    await showSearching(false);
    if (run !== lookupRun) return; // a new search started during the fade
    if (data.results.length === 0) {
      setStatus(`No products found for “${data.query}”. Only styles with a box number can be looked up.`);
      return;
    }
    if (data.record) {
      setStatus("1 product found.");
      renderDetail(data.record);
      return;
    }
    setStatus(
      `${data.results.length}${data.capped ? "+" : ""} products match “${data.query}”. Select one to see its fields.`
    );
    renderResults(data.results);
  } catch (error) {
    if (run !== lookupRun) return;
    await showSearching(false);
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

// Plays the mouse video while a lookup runs. Fading out resolves once the fade finishes,
// so results appear in the space the video leaves rather than pushing it down.
let searchingToken = 0;
function showSearching(on) {
  const box = $("#lookup-searching");
  const video = box.querySelector("video");
  const token = ++searchingToken;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (on) {
    box.hidden = false;
    video.currentTime = 0;
    if (!reduceMotion) video.play().catch(() => {});
    void box.offsetWidth; // commit the hidden state so the fade-in transitions
    box.classList.add("is-visible");
    return Promise.resolve();
  }

  if (box.hidden) return Promise.resolve();
  box.classList.remove("is-visible");
  return new Promise((resolve) => {
    const done = () => {
      if (token === searchingToken) {
        box.hidden = true;
        video.pause();
      }
      resolve();
    };
    if (reduceMotion) return done();
    // transitionend can be skipped (e.g. background tab), so fall back to a timer.
    const timer = setTimeout(done, 700);
    box.addEventListener("transitionend", () => { clearTimeout(timer); done(); }, { once: true });
  });
}

// Looks up each value in turn, filling its row as soon as it arrives rather than waiting for the whole list.
async function lookupBatch(queries) {
  const run = ++lookupRun;
  state.detail = null;
  const skipped = Math.max(0, queries.length - MAX_BATCH);
  queries = queries.slice(0, MAX_BATCH);
  const skippedNote = skipped ? ` Only the first ${MAX_BATCH} are looked up; ${skipped} skipped.` : "";

  $("#lookup-empty").hidden = true;
  $("#detail").replaceChildren();
  // Shopify: preview every found row, then update the ones that are matched and have changes.
  const previewAll = el("button", { class: "button button--ghost button--small", type: "button" }, "Preview Shopify updates");
  const dryRunAll = el("button", { class: "button button--ghost button--small", type: "button" }, "Dry run");
  const updateAll = el("button", { class: "button button--small", type: "button" }, "Update Shopify");
  previewAll.disabled = dryRunAll.disabled = updateAll.disabled = true;
  let syncing = true; // also true while the lookups themselves are still running
  const updatable = () => items.filter((i) => i.sync?.state().canUpdate);
  const products = (n) => `${n} product${n === 1 ? "" : "s"}`;
  const refreshSyncButtons = () => {
    const n = updatable().length;
    previewAll.disabled = syncing;
    dryRunAll.disabled = updateAll.disabled = syncing || n === 0;
    dryRunAll.textContent = n ? `Dry run ${products(n)}` : "Dry run";
    updateAll.textContent = n ? `Update ${products(n)}` : "Update Shopify";
    // In dry run mode the server won't write anything, so don't offer a real update.
    updateAll.hidden = items.some((i) => i.sync?.state().dryRunOnly);
  };
  const forEachSync = async (rows, action) => {
    syncing = true;
    refreshSyncButtons();
    for (const item of rows) {
      if (run !== lookupRun || !state.signedIn) return;
      await action(item.sync);
    }
    syncing = false;
    refreshSyncButtons();
  };
  previewAll.addEventListener("click", () => forEachSync(items.filter((i) => i.sync), (sync) => sync.load()));
  dryRunAll.addEventListener("click", async () => {
    const rows = updatable();
    await forEachSync(rows, (sync) => sync.update({ dryRun: true }));
    if (run === lookupRun) setStatus(`Dry run complete for ${products(rows.length)}. Nothing was written to Shopify; expand a row to see what would be sent.`);
  });
  updateAll.addEventListener("click", () => {
    const rows = updatable();
    if (!confirm(`Update ${products(rows.length)} in Shopify with the previewed changes?`)) return;
    forEachSync(rows, (sync) => sync.update());
  });

  const items = queries.map((q) => batchItem(q, refreshSyncButtons));

  const toggleAll = el("button", { class: "link-button", type: "button" }, "Expand all");
  toggleAll.addEventListener("click", () => {
    const ready = items.filter((i) => i.node.dataset.ready);
    const open = !ready.every((i) => i.node.open);
    for (const i of ready) i.node.open = open;
    toggleAll.textContent = open ? "Collapse all" : "Expand all";
  });
  const toolbar = el("div", { class: "batch__toolbar" }, [
    el("span", {}, [`${queries.length} values · showing fields chosen in `, el("a", { href: "#/settings" }, "Settings")]),
    el("div", { class: "batch__actions" }, [previewAll, dryRunAll, updateAll, toggleAll]),
  ]);
  $("#results").replaceChildren(el("div", { class: "batch" }, [toolbar, ...items.map((i) => i.node)]));

  showSearching(true);
  const counts = { found: 0, several: 0, missing: 0, failed: 0 };
  for (const [index, item] of items.entries()) {
    setStatus(`Looking up ${index + 1} of ${items.length}…${skippedNote}`);
    item.setLoading();
    try {
      const data = await api(`/api/lookup?q=${encodeURIComponent(item.query)}`);
      if (run !== lookupRun) return;
      counts[item.setResult(data)]++;
    } catch (error) {
      if (run !== lookupRun || !state.signedIn) return;
      item.setError(error.message);
      counts.failed++;
    }
    // The video only covers the wait for the first row; after that the rows show progress themselves.
    if (index === 0) showSearching(false);
  }

  const parts = [
    `${counts.found} found`,
    counts.several && `${counts.several} with several matches`,
    counts.missing && `${counts.missing} not found`,
    counts.failed && `${counts.failed} failed`,
  ].filter(Boolean);
  setStatus(`Looked up ${items.length} values: ${parts.join(", ")}.${skippedNote}`, counts.failed > 0);
  syncing = false;
  refreshSyncButtons();
}

// One collapsible row in a batch. It can only be opened once there's something to show.
// `onSync` is called whenever the row's Shopify state changes.
function batchItem(query, onSync = () => {}) {
  let sync = null; // the row's Shopify panel, once it has a record
  const syncBadge = el("span");
  const summary = el("summary", { class: "batch-item__summary" });
  const body = el("div", { class: "batch-item__body" });
  const node = el("details", { class: "batch-item is-queued" }, [summary, body]);
  summary.addEventListener("click", (e) => {
    if (!node.dataset.ready) e.preventDefault();
  });

  const paint = ({ image, title, meta, badge, metaClass = "" }) => {
    summary.replaceChildren(
      image ? el("img", { class: "result__thumb", src: safeUrl(image), alt: "" }) : el("div", { class: "result__thumb" }),
      el("div", { class: "batch-item__text" }, [
        el("div", { class: "result__title" }, title),
        el("div", { class: `result__meta ${metaClass}` }, meta),
      ]),
      badge ?? el("span")
    );
  };
  const searched = `“${query}”`;

  const showRecord = (record) => {
    const s = recordSummary(record);
    node.className = "batch-item";
    node.dataset.ready = "true";
    const differs = s.box && s.box.toUpperCase() !== query.toUpperCase();
    paint({
      image: s.image?.thumbnails?.small?.url ?? s.image?.url,
      title: `${s.box ?? "—"} · ${s.description ?? "Untitled"}`,
      meta: [differs && `Searched ${searched}`, s.colourway, s.po && `PO ${s.po}`, s.pattern && `Pattern ${s.pattern}`].filter(Boolean).join(" · "),
      badge: el("span", { class: "batch-item__badges" }, [syncBadge, techPackPill(s.techPack), skuPill(s.sku)]),
    });
    sync = shopifyPanel(record, {
      autoLoad: false,
      onState: (s) => {
        syncBadge.replaceChildren(syncPill(s));
        onSync();
      },
    });
    body.replaceChildren(...compactDetail(record), sync.node);
  };

  paint({ title: searched, meta: "Queued" });

  return {
    node,
    query,
    get sync() {
      return sync;
    },
    setLoading() {
      node.className = "batch-item is-loading";
      paint({ title: searched, meta: "Looking up…" });
    },
    setError(message) {
      node.className = "batch-item is-missing";
      paint({ title: searched, meta: message, metaClass: "value-error" });
    },
    // Returns which bucket the result falls in, for the summary line.
    setResult(data) {
      if (data.record) {
        showRecord(data.record);
        return "found";
      }
      if (data.results.length === 0) {
        node.className = "batch-item is-missing";
        paint({ title: searched, meta: "No product with a box number matches", badge: el("span", { class: "pill pill--no" }, "Not found") });
        return "missing";
      }
      node.className = "batch-item";
      node.dataset.ready = "true";
      paint({
        title: searched,
        meta: `${data.results.length}${data.capped ? "+" : ""} products match. Expand to choose one.`,
        badge: el("span", { class: "pill pill--no" }, `${data.results.length}${data.capped ? "+" : ""} matches`),
      });
      body.replaceChildren(
        el("div", { class: "results results--nested" }, data.results.map((r) => {
          const button = resultButton(r);
          button.addEventListener("click", async () => {
            body.replaceChildren(el("p", { class: "status" }, "Loading product…"));
            try {
              showRecord((await api(`/api/lookup?id=${encodeURIComponent(r.id)}`)).record);
            } catch (error) {
              body.replaceChildren(el("p", { class: "status status--error" }, error.message));
            }
          });
          return button;
        }))
      );
      return "several";
    },
  };
}

// Dense grid of the fields chosen in Settings that have a value, for batch rows.
function compactDetail(record) {
  const fields = record.fields.filter((f) => f.visible && !isEmpty(f.value));
  const hidden = record.fields.filter((f) => f.visible).length - fields.length;
  return [
    fields.length
      ? el("dl", { class: "compact-fields" }, fields.map((f) =>
          el("div", {}, [el("dt", {}, f.name), el("dd", {}, [renderValue(f, record.id)])])
        ))
      : el("p", { class: "status" }, "None of the chosen fields have a value."),
    el("p", { class: "batch-item__links" }, [
      el("a", { href: record.airtableUrl, target: "_blank", rel: "noopener" }, "Open in Airtable ↗"),
      hidden > 0 && el("span", {}, `${hidden} empty field${hidden === 1 ? "" : "s"} hidden`),
    ]),
  ];
}

function resultButton(r) {
  return el("button", { class: "result", type: "button" }, [
    r.thumbnail ? el("img", { class: "result__thumb", src: safeUrl(r.thumbnail), alt: "" }) : el("div", { class: "result__thumb" }),
    el("div", {}, [
      el("div", { class: "result__title" }, `${r.box ?? "—"} · ${r.description ?? "Untitled"}`),
      el("div", { class: "result__meta" }, [r.colourway, r.po && `PO ${r.po}`, r.pattern && `Pattern ${r.pattern}`].filter(Boolean).join(" · ")),
    ]),
    releasedPill(r.released),
  ]);
}

function releasedPill(released) {
  return el("span", { class: `pill ${released ? "pill--yes" : "pill--no"}` }, released ? "Released" : "Not released");
}

// Batch rows flag what's missing, so gaps show without expanding every row.
function techPackPill(techPack) {
  return el("span", { class: `pill ${techPack ? "pill--yes" : "pill--error"}`, title: techPack?.filename }, techPack ? "Tech pack" : "No tech pack");
}

function skuPill(sku) {
  return el("span", { class: sku ? "pill" : "pill pill--error" }, sku ? `SKU ${sku}` : "No SKU");
}

// The headline values shown at the top of a product, pulled from its field list.
function recordSummary(record) {
  const field = (name) => record.fields.find((f) => f.name === name)?.value;
  const firstText = (v) => (Array.isArray(v) ? v.find((x) => typeof x === "string" && x.trim()) : v);
  return {
    image: [].concat(field("IMAGE (from PO#) (from COLOURWAY TAG LINK)") ?? []).find((a) => a?.url) ?? null,
    box: trim(field("BOX#")) || null,
    description: trim(firstText(field("Description"))) || null,
    colourway: trim(firstText(field("COLOURWAY"))) || null,
    po: field("BACK-UP PO#") ?? null,
    pattern: trim(firstText(field("PATTERN#"))) || null,
    released: Boolean(field("Released")),
    sku: [].concat(field("SKU") ?? []).map((x) => String(x?.name ?? x).trim()).find(Boolean) ?? null,
    // The first PDF is the one that's read for Shopify (see firstPdf in pdf-extract.mjs).
    techPack: [].concat(field("PDF BULK TECH PACK") ?? []).find((a) => a?.id && a.type === "application/pdf") ?? null,
  };
}

function renderResults(results) {
  const list = el("div", { class: "results" });
  for (const r of results) {
    const button = resultButton(r);
    button.addEventListener("click", async () => {
      list.querySelectorAll(".result").forEach((b) => b.removeAttribute("aria-current"));
      button.setAttribute("aria-current", "true");
      $("#detail").replaceChildren(el("p", { class: "status" }, "Loading product…"));
      try {
        const data = await api(`/api/lookup?id=${encodeURIComponent(r.id)}`);
        renderDetail(data.record);
        $("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (error) {
        $("#detail").replaceChildren(el("p", { class: "status status--error" }, error.message));
      }
    });
    list.append(button);
  }
  $("#results").replaceChildren(list);
}

function renderDetail(record) {
  state.detail = record;
  const s = recordSummary(record);

  const head = el("div", { class: "detail-head" }, [
    s.image ? el("img", { class: "detail-head__image", src: safeUrl(s.image.thumbnails?.large?.url ?? s.image.url), alt: "" }) : el("div", { class: "detail-head__image" }),
    el("div", {}, [
      el("p", { class: "h5" }, record.table),
      el("h2", { class: "detail-head__title" }, `${s.box ?? ""} ${s.description ?? ""}`.trim()),
      el("p", { class: "detail-head__meta" }, [s.colourway, s.po && `PO ${s.po}`, s.pattern && `Pattern ${s.pattern}`].filter(Boolean).join(" · ")),
      releasedPill(s.released),
      el("p", {}, [el("a", { href: record.airtableUrl, target: "_blank", rel: "noopener" }, "Open in Airtable ↗")]),
    ]),
  ]);

  const filter = el("input", { type: "search", placeholder: "Filter fields", "aria-label": "Filter fields", value: state.filter });
  const hideEmpty = el("input", { type: "checkbox" });
  hideEmpty.checked = state.hideEmpty;
  const showAll = el("input", { type: "checkbox" });
  showAll.checked = state.showAll;
  const count = el("span", { class: "toolbar__count" });
  const tbody = el("tbody");

  const draw = () => {
    const f = state.filter.toLowerCase();
    const inScope = record.fields.filter((x) => state.showAll || x.visible);
    const filled = inScope.filter((x) => !isEmpty(x.value)).length;
    const rows = [];
    let shown = 0;
    let lastGroup = null;
    for (const fieldDef of inScope) {
      const empty = isEmpty(fieldDef.value);
      if (state.hideEmpty && empty) continue;
      if (f && !fieldDef.name.toLowerCase().includes(f)) continue;
      if (fieldDef.group !== lastGroup) {
        rows.push(el("tr", { class: "fields__group" }, [el("th", { colspan: "2", scope: "colgroup" }, fieldDef.group)]));
        lastGroup = fieldDef.group;
      }
      shown++;
      rows.push(
        el("tr", { class: empty ? "is-empty" : "" }, [
          el("th", { scope: "row" }, [fieldDef.name, el("small", {}, typeLabel(fieldDef))]),
          el("td", {}, [renderValue(fieldDef, record.id)]),
        ])
      );
    }
    if (shown === 0) rows.push(el("tr", {}, [el("td", { colspan: "2", class: "status" }, "No fields match.")]));
    tbody.replaceChildren(...rows);
    count.textContent = `${filled} of ${inScope.length} fields filled · showing ${shown}`;
  };

  filter.addEventListener("input", () => { state.filter = filter.value; draw(); });
  hideEmpty.addEventListener("change", () => { state.hideEmpty = hideEmpty.checked; draw(); });
  showAll.addEventListener("change", () => { state.showAll = showAll.checked; draw(); });

  const toolbar = el("div", { class: "toolbar" }, [
    filter,
    el("label", {}, [hideEmpty, "Hide empty fields"]),
    el("label", {}, [showAll, "Show all fields"]),
    el("a", { href: "#/settings" }, "Choose fields"),
    count,
  ]);

  draw();
  $("#detail").replaceChildren(head, shopifyPanel(record).node, toolbar, el("table", { class: "fields" }, [tbody]));
}

// ---------- Settings ----------
function isDirty() {
  if (!state.settings) return false;
  if (state.selection.size !== state.savedSelection.size) return true;
  for (const id of state.selection) if (!state.savedSelection.has(id)) return true;
  return false;
}

function setSettingsStatus(text, kind = "") {
  const s = $("#settings-status");
  s.textContent = text;
  s.className = `status${kind ? ` status--${kind}` : ""}`;
}

function applySettings(data) {
  state.settings = data;
  const selected = data.groups.flatMap((g) => g.fields.filter((f) => f.selected).map((f) => f.id));
  state.selection = new Set(selected);
  state.savedSelection = new Set(selected);
  $("#settings-table").textContent = data.table;
}

function savedLabel() {
  const s = state.settings;
  if (!s) return "";
  if (s.usingDefaults) return "Using Motto's recommended fields.";
  const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString("en-AU") : "";
  return `Last saved ${when}${s.updatedBy ? ` by ${s.updatedBy}` : ""}.`;
}

async function loadSettings({ refresh = false } = {}) {
  if (state.settings && !refresh) return renderSettings();
  setSettingsStatus(refresh ? "Refreshing fields from Airtable…" : "Loading fields from Airtable…");
  try {
    const data = await api(`/api/settings${refresh ? "?refresh=1" : ""}`);
    const pending = refresh && isDirty() ? new Set(state.selection) : null;
    applySettings(data);
    if (pending) state.selection = pending;
    renderSettings();
    setSettingsStatus(savedLabel());
  } catch (error) {
    setSettingsStatus(error.message, "error");
  }
}

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  const f = state.settingsFilter.toLowerCase();
  const container = $("#settings-groups");
  const groups = [];

  for (const group of s.groups) {
    const visibleFields = group.fields.filter((x) => !f || x.name.toLowerCase().includes(f));
    if (visibleFields.length === 0) continue;
    const selectedInGroup = group.fields.filter((x) => state.selection.has(x.id)).length;

    const all = el("button", { class: "link-button", type: "button" }, "Select all");
    const none = el("button", { class: "link-button", type: "button" }, "Clear");
    all.addEventListener("click", () => { visibleFields.forEach((x) => state.selection.add(x.id)); renderSettings(); });
    none.addEventListener("click", () => { visibleFields.forEach((x) => state.selection.delete(x.id)); renderSettings(); });

    const list = el("ul", { class: "settings-group__list" });
    for (const fieldDef of visibleFields) {
      const checkbox = el("input", { type: "checkbox", value: fieldDef.id });
      checkbox.checked = state.selection.has(fieldDef.id);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selection.add(fieldDef.id);
        else state.selection.delete(fieldDef.id);
        updateSettingsBar();
        groupCount.textContent = `${group.fields.filter((x) => state.selection.has(x.id)).length} of ${group.fields.length} selected`;
      });
      list.append(
        el("li", {}, [
          el("label", { class: "setting" }, [
            checkbox,
            el("span", {}, [
              el("span", { class: "setting__name" }, [fieldDef.name, fieldDef.recommended ? el("span", { class: "badge", title: "Recommended in Motto's brief" }, "Rec") : null]),
              el("span", { class: "setting__type" }, typeLabel(fieldDef)),
            ]),
          ]),
        ])
      );
    }

    const groupCount = el("span", { class: "settings-bar__count" }, `${selectedInGroup} of ${group.fields.length} selected`);
    groups.push(
      el("section", { class: "settings-group" }, [
        el("div", { class: "settings-group__head" }, [el("h2", { class: "h5" }, group.name), groupCount, all, none]),
        list,
      ])
    );
  }

  if (groups.length === 0) groups.push(el("p", { class: "status" }, "No fields match."));
  container.replaceChildren(...groups);
  updateSettingsBar();
}

function updateSettingsBar() {
  const total = state.settings?.groups.reduce((n, g) => n + g.fields.length, 0) ?? 0;
  $("#settings-count").textContent = `${state.selection.size} of ${total} fields shown in lookup`;
  $("#settings-save").disabled = !isDirty() || state.selection.size === 0;
  $("#settings-save").textContent = isDirty() ? "Save changes" : "Saved";
}

$("#settings-filter").addEventListener("input", (e) => {
  state.settingsFilter = e.target.value;
  renderSettings();
});

$("#settings-save").addEventListener("click", async () => {
  const button = $("#settings-save");
  button.disabled = true;
  setSettingsStatus("Saving…");
  try {
    const data = await api("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedFieldIds: [...state.selection] }),
    });
    applySettings(data);
    renderSettings();
    setSettingsStatus(`Saved. ${savedLabel()}`, "success");
    refreshOpenDetail();
  } catch (error) {
    setSettingsStatus(error.message, "error");
    updateSettingsBar();
  }
});

$("#settings-reset").addEventListener("click", async () => {
  if (!confirm("Reset the lookup to Motto's recommended fields? Your current selection will be replaced.")) return;
  setSettingsStatus("Resetting…");
  try {
    const data = await api("/api/settings", { method: "DELETE" });
    applySettings(data);
    renderSettings();
    setSettingsStatus("Reset to Motto's recommended fields.", "success");
    refreshOpenDetail();
  } catch (error) {
    setSettingsStatus(error.message, "error");
  }
});

$("#settings-refresh").addEventListener("click", () => loadSettings({ refresh: true }));

// ---------- Settings: PDF prompt ----------
// The page edits the tech pack prompt, which is the only extract there is.
const PROMPT_EXTRACT = "tech-pack";
const savedPrompt = () => state.prompts?.extracts.find((x) => x.id === PROMPT_EXTRACT) ?? null;

function isPromptDirty() {
  const saved = savedPrompt();
  return Boolean(saved) && $("#prompt-text").value.trim() !== saved.prompt;
}

function setPromptStatus(text, kind = "") {
  const s = $("#prompt-status");
  s.textContent = text;
  s.className = `status${kind ? ` status--${kind}` : ""}`;
}

function applyPrompts(data) {
  state.prompts = data;
  const saved = savedPrompt();
  $("#prompt-text").value = saved.prompt;
  $("#prompt-text").maxLength = data.maxChars;
  $("#prompt-text").disabled = false;
  $("#prompt-field").textContent = saved.field;
  updatePromptBar();
}

function updatePromptBar() {
  const saved = savedPrompt();
  if (!saved) return;
  const dirty = isPromptDirty();
  const edited = saved.updatedAt
    ? `Edited ${new Date(saved.updatedAt).toLocaleString("en-AU")}${saved.updatedBy ? ` by ${saved.updatedBy}` : ""}`
    : "Edited";
  $("#prompt-hint").textContent = dirty ? "Unsaved changes" : saved.isDefault ? "Using the default prompt" : edited;
  $("#prompt-count").textContent = `${$("#prompt-text").value.length.toLocaleString("en-AU")} characters`;
  $("#prompt-save").disabled = !dirty || !$("#prompt-text").value.trim();
  $("#prompt-save").textContent = dirty ? "Save changes" : "Saved";
  // Nothing to reset when the default is already showing.
  $("#prompt-reset").disabled = saved.isDefault && !dirty;
}

async function loadPrompt() {
  if (state.prompts) return;
  setPromptStatus("Loading the prompt…");
  try {
    applyPrompts(await api("/api/pdf/prompts"));
    setPromptStatus("");
  } catch (error) {
    setPromptStatus(error.message, "error");
  }
}

async function sendPrompt(method, body, done) {
  $("#prompt-save").disabled = $("#prompt-reset").disabled = true;
  setPromptStatus("Saving…");
  try {
    applyPrompts(await api("/api/pdf/prompts", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
    setPromptStatus(done, "success");
  } catch (error) {
    setPromptStatus(error.message, "error");
    updatePromptBar();
  }
}

$("#prompt-text").addEventListener("input", updatePromptBar);
$("#prompt-save").addEventListener("click", () =>
  sendPrompt("PUT", { extract: PROMPT_EXTRACT, prompt: $("#prompt-text").value }, "Saved. Tech packs are read with this prompt from now on.")
);
$("#prompt-reset").addEventListener("click", () => {
  if (savedPrompt().isDefault) {
    // Only unsaved edits to undo.
    $("#prompt-text").value = savedPrompt().prompt;
    setPromptStatus("");
    return updatePromptBar();
  }
  if (!confirm("Go back to the default tech pack prompt? Your edited prompt will be replaced.")) return;
  sendPrompt("DELETE", { extract: PROMPT_EXTRACT }, "Reset to the default prompt.");
});

// Re-fetch the product currently shown so it reflects the new field selection.
async function refreshOpenDetail() {
  if (!state.detail) return;
  try {
    const data = await api(`/api/lookup?id=${encodeURIComponent(state.detail.id)}`);
    renderDetail(data.record);
  } catch {
    /* the next lookup will pick up the new settings */
  }
}

// ---------- Shopify mapping ----------
const MODE_LABELS = { merge: "Merge", replace: "Replace", new: "New" };
const MODE_HELP = {
  merge: "Add to what's already in Shopify",
  replace: "Overwrite the Shopify value",
  new: "Only fill the field if it's empty in Shopify",
};

function isMappingDirty() {
  return Boolean(state.mapping) && JSON.stringify(state.mappingRows) !== state.savedMappingRows;
}

function setMappingStatus(text, kind = "") {
  const s = $("#mapping-status");
  s.textContent = text;
  s.className = `status${kind ? ` status--${kind}` : ""}`;
}

function applyMapping(data) {
  state.mapping = data;
  state.mappingRows = data.mappings.map(({ id, sourceFieldId, target, mode }) => ({ id, sourceFieldId, target, mode }));
  state.savedMappingRows = JSON.stringify(state.mappingRows);
  $("#mapping-table").textContent = data.table;
  const notice = $("#mapping-notice");
  notice.hidden = data.shopify.connected;
  notice.textContent = data.shopify.connected
    ? ""
    : `Shopify isn't connected (${data.shopify.error}). You can map to native product and variant fields, but metafields can't be listed until it's connected. `;
  if (!data.shopify.connected) notice.append(el("a", { href: "/api/shopify/connect" }, "Connect Shopify"));
}

function mappingSavedLabel() {
  const m = state.mapping;
  if (!m?.updatedAt) return "No mappings saved yet.";
  return `Last saved ${new Date(m.updatedAt).toLocaleString("en-AU")}${m.updatedBy ? ` by ${m.updatedBy}` : ""}.`;
}

async function loadMapping({ refresh = false } = {}) {
  if (state.mapping && !refresh) return renderMapping();
  setMappingStatus(refresh ? "Refreshing fields from Airtable and Shopify…" : "Loading mappings…");
  try {
    const data = await api(`/api/mappings${refresh ? "?refresh=1" : ""}`);
    const pending = refresh && isMappingDirty() ? state.mappingRows : null;
    applyMapping(data);
    if (pending) state.mappingRows = pending;
    renderMapping();
    setMappingStatus(mappingSavedLabel());
  } catch (error) {
    setMappingStatus(error.message, "error");
  }
}

function targetById(id) {
  for (const group of state.mapping.targets) {
    const t = group.fields.find((f) => f.id === id);
    if (t) return t;
  }
  return null;
}

function renderMapping() {
  const m = state.mapping;
  if (!m) return;
  const saved = new Map(m.mappings.map((x) => [x.id, x]));
  const rows = state.mappingRows.map((row, i) => renderMappingRow(row, i, saved.get(row.id)));
  if (rows.length === 0) {
    rows.push(el("p", { class: "status" }, "No mappings yet. Add one to choose where an Airtable field goes in Shopify."));
  }
  $("#mapping-rows").replaceChildren(
    el("div", { class: "mapping-head", "aria-hidden": "true" }, [
      el("span", {}, "Airtable field"), el("span", {}, ""), el("span", {}, "Shopify field"), el("span", {}, "Existing data"), el("span", {}, ""),
    ]),
    ...rows
  );
  renderBuiltIn(m.builtIn ?? []);
  updateMappingBar();
}

const BUILTIN_STATUS = {
  ready: () => "Ready",
  missing: (b) => `Create ${b.metafield} (${b.type}) in Shopify`,
  "wrong-type": (b) => `${b.metafield} is ${b.foundType} in Shopify; it has to be ${b.type}`,
  overridden: () => "Replaced by a mapping above",
  unknown: () => "Can't check until Shopify is connected",
};

// The mappings Mouse applies by itself (builtin-mappings.mjs). They can't be edited here, only replaced by
// mapping something else to the same Shopify field.
function renderBuiltIn(builtIn) {
  $("#mapping-builtin").replaceChildren(
    ...(builtIn.length
      ? [
          el("h2", { class: "h5 settings-heading" }, "Built-in mappings"),
          el("p", { class: "subdued" }, "Always sent to Shopify, overwriting what's there, so Product Pelican has the source data it writes from. Each needs a product metafield definition in Shopify with the namespace, key and type shown."),
          el("table", { class: "sync-table builtin-table" }, [
            el("thead", {}, el("tr", {}, ["Shopify metafield", "Sent from", "Status"].map((h) => el("th", { scope: "col" }, h)))),
            el("tbody", {}, builtIn.map((b) =>
              el("tr", {}, [
                el("th", { scope: "row" }, [b.name, el("small", {}, `${b.metafield} · ${b.type}`)]),
                el("td", {}, b.sources.join(" · ")),
                el("td", { class: b.status === "ready" ? "" : "muted" }, BUILTIN_STATUS[b.status](b)),
              ])
            )),
          ]),
        ]
      : [])
  );
}

function renderMappingRow(row, index, saved) {
  const source = el("select", { "aria-label": `Row ${index + 1} Airtable field` }, [
    el("option", { value: "" }, "Choose Airtable field…"),
    ...state.mapping.sources.map((g) =>
      el("optgroup", { label: g.name }, g.fields.map((f) => el("option", { value: f.id }, f.name)))
    ),
  ]);
  if (saved?.sourceMissing) source.prepend(el("option", { value: row.sourceFieldId }, "Missing field (deleted in Airtable)"));
  source.value = row.sourceFieldId ?? "";
  source.addEventListener("change", () => { row.sourceFieldId = source.value; updateMappingBar(); });

  const target = el("select", { "aria-label": `Row ${index + 1} Shopify field` }, [
    el("option", { value: "" }, "Choose Shopify field…"),
    ...state.mapping.targets
      .filter((g) => g.fields.length)
      .map((g) =>
        el("optgroup", { label: g.name }, g.fields.map((f) => el("option", { value: f.id, title: f.detail ?? "" }, f.detail ? `${f.label} (${f.detail.split(" · ")[0]})` : f.label)))
      ),
  ]);
  const known = targetById(row.target);
  if (row.target && !known) {
    const label = saved?.targetMissing ? "Missing metafield (deleted in Shopify)" : row.target.replace(/^(product|variant):metafield:/, "$1 metafield ");
    target.prepend(el("option", { value: row.target }, label));
  }
  target.value = row.target ?? "";
  target.addEventListener("change", () => {
    row.target = target.value;
    const t = targetById(row.target);
    if (t && !t.modes.includes(row.mode)) row.mode = t.modes.includes("replace") ? "replace" : t.modes[0];
    // The fields going into a JSON metafield are written together, so a new row follows the others.
    const sibling = t?.kind === "json" && state.mappingRows.find((r) => r !== row && r.target === row.target);
    if (sibling) row.mode = sibling.mode;
    renderMapping();
  });

  // If the target isn't known (Shopify offline), allow every mode and let the server check on save.
  const modes = known?.modes ?? ["merge", "replace", "new"];
  const modeGroup = el("div", { class: "segmented", role: "radiogroup", "aria-label": `Row ${index + 1} existing data` },
    ["merge", "replace", "new"].map((mode) => {
      const input = el("input", { type: "radio", name: `mode-${row.id}`, value: mode });
      input.checked = row.mode === mode;
      input.disabled = !modes.includes(mode);
      input.addEventListener("change", () => {
        row.mode = mode;
        if (known?.kind !== "json") return updateMappingBar();
        for (const r of state.mappingRows) if (r.target === row.target) r.mode = mode;
        renderMapping();
      });
      return el("label", { class: "segmented__option", title: input.disabled ? "Only text, list and JSON fields can be merged" : MODE_HELP[mode] }, [
        input,
        el("span", {}, MODE_LABELS[mode]),
      ]);
    })
  );

  const remove = el("button", { class: "link-button", type: "button", "aria-label": `Remove row ${index + 1}` }, "Remove");
  remove.addEventListener("click", () => {
    state.mappingRows.splice(index, 1);
    renderMapping();
  });

  return el("div", { class: "mapping-row" }, [source, el("span", { class: "mapping-row__arrow", "aria-hidden": "true" }, "→"), target, modeGroup, remove]);
}

function updateMappingBar() {
  const n = state.mappingRows.length;
  $("#mapping-count").textContent = `${n} mapping${n === 1 ? "" : "s"}`;
  const incomplete = state.mappingRows.some((r) => !r.sourceFieldId || !r.target || !r.mode);
  const dirty = isMappingDirty();
  $("#mapping-save").disabled = !dirty || incomplete;
  $("#mapping-save").textContent = dirty ? "Save changes" : "Saved";
}

$("#mapping-add").addEventListener("click", () => {
  state.mappingRows.push({ id: crypto.randomUUID(), sourceFieldId: "", target: "", mode: "replace" });
  renderMapping();
  $("#mapping-rows .mapping-row:last-of-type select")?.focus();
});

$("#mapping-refresh").addEventListener("click", () => loadMapping({ refresh: true }));

$("#mapping-save").addEventListener("click", async () => {
  const button = $("#mapping-save");
  button.disabled = true;
  setMappingStatus("Saving…");
  try {
    const data = await api("/api/mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mappings: state.mappingRows }),
    });
    applyMapping(data);
    renderMapping();
    setMappingStatus(`Saved. ${mappingSavedLabel()}`, "success");
  } catch (error) {
    setMappingStatus(error.message, "error");
    updateMappingBar();
  }
});

// ---------- Shopify sync ----------
const MATCH_LABELS = { sku: "Matched by SKU", pattern: "Matched by pattern and colour", chosen: "Chosen" };

// A block that matches one Airtable record to its Shopify product, previews what the saved mappings
// would change, and applies it on request. `onState` is told whenever that changes (batch rows show it as a pill).
function shopifyPanel(record, { autoLoad = true, onState = () => {} } = {}) {
  const body = el("div");
  const node = el("section", { class: "sync" }, [el("h3", { class: "h5" }, "Shopify"), body]);
  const endpoint = "/api/shopify/sync";
  let data = null; // last response from the endpoint
  let phase = "idle"; // idle | loading | ready | error
  let message = null; // { text, kind } shown under the preview
  let choosing = false; // the user asked to pick a different product
  let reading = false; // a mapped PDF is being read; the preview is redone when that finishes
  const unread = new Map(); // attachment id -> why its PDF couldn't be read, so it isn't retried on every preview

  const snapshot = () => {
    if (phase !== "ready") return { phase };
    if (!data.connected) return { phase, status: "disconnected" };
    if (data.match.product && data.mappingCount === 0) return { phase, status: "unmapped" };
    const changes = data.preview?.changeCount ?? 0;
    return {
      phase,
      status: data.match.status,
      changes,
      canUpdate: Boolean(data.match.product) && changes > 0 && !reading,
      dryRunOnly: data.dryRunOnly,
      reading,
      unread: (data.extracts ?? []).some((e) => unread.has(e.attachmentId)),
    };
  };

  // Mapped PDFs (the tech pack) are read the first time their product is previewed, then the preview is
  // redone with their text. Only once there's a product to update, since reading one takes a minute or two.
  const readExtracts = async () => {
    const needed = () =>
      phase === "ready" && data.preview ? (data.extracts ?? []).filter((e) => e.status === "needed" && !unread.has(e.attachmentId)) : [];
    if (needed().length === 0) return;
    reading = true;
    render();
    onState(snapshot());
    for (const e of needed()) {
      const result = await runExtract({ recordId: record.id, fieldId: e.fieldId, attachmentId: e.attachmentId, extract: e.extract });
      if (result.error) unread.set(e.attachmentId, result.error);
    }
    try {
      data = { ...(await fetchPreview()), result: data.result };
      // Still not there after a read that reported no error: don't go round again.
      for (const e of needed()) unread.set(e.attachmentId, "The text read from the PDF wasn't saved");
    } catch (error) {
      message = { text: error.message, kind: "error" };
    }
    reading = false;
  };

  // Runs a request, showing `label` meanwhile. On failure `recover` (if given) reloads the preview so the error has context.
  const run = async (label, request, recover) => {
    phase = "loading";
    body.replaceChildren(el("p", { class: "status" }, label));
    onState(snapshot());
    try {
      data = await request();
      phase = "ready";
    } catch (error) {
      message = { text: error.message, kind: "error" };
      phase = "error";
      if (recover && state.signedIn) {
        try {
          data = await recover();
          phase = "ready";
        } catch {}
      }
    }
    await readExtracts();
    render();
    onState(snapshot());
  };

  const fetchPreview = (choose = false) => api(`${endpoint}?id=${encodeURIComponent(record.id)}${choose ? "&choose" : ""}`);
  const send = (method, payload) =>
    api(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recordId: record.id, ...payload }) });

  const load = () => {
    message = null;
    choosing = false;
    unread.clear();
    return run("Checking Shopify…", () => fetchPreview());
  };
  const choose = () => {
    message = null;
    choosing = true;
    return run("Finding products…", () => fetchPreview(true));
  };
  const link = (productId) => {
    message = null;
    choosing = false;
    return run("Saving…", () => send("PUT", { productId }), () => fetchPreview());
  };
  // A dry run goes through the whole update without sending anything to Shopify, and shows what would be sent.
  const update = ({ dryRun = false } = {}) => {
    if (!snapshot().canUpdate) return Promise.resolve();
    const payload = { productId: data.match.product.id, fingerprint: data.preview.fingerprint, dryRun };
    return run(
      dryRun ? "Running dry run…" : "Updating Shopify…",
      async () => {
        const res = await send("POST", payload);
        const { saved, failed, requests } = res.result;
        const count = `${saved} value${saved === 1 ? "" : "s"}`;
        if (res.result.dryRun) {
          message = {
            text: `Dry run complete: ${count} would be saved in ${requests.length} Shopify request${requests.length === 1 ? "" : "s"}. Nothing was written.`,
            kind: "success",
          };
        } else if (failed) {
          message = { text: `${count} saved, ${failed} failed. See the rows marked Failed.`, kind: "error" };
        } else {
          message = { text: `Updated ${count} in Shopify.`, kind: "success" };
        }
        return res;
      },
      () => fetchPreview()
    );
  };

  const thumb = (url) => (url ? el("img", { class: "result__thumb", src: safeUrl(url), alt: "" }) : el("div", { class: "result__thumb" }));
  const productMeta = (p) => [p.colours.join(" / "), p.sku && `SKU ${p.sku}`, p.status.toLowerCase()].filter(Boolean).join(" · ");
  const values = (list) => {
    if (list.length === 0 || (list.length === 1 && list[0] == null)) return el("span", { class: "muted" }, "Empty");
    return list.map((v) => v ?? "Empty").join(" · ");
  };

  // Where a row's value comes from. A JSON metafield can combine dozens of fields, so those are counted, not listed.
  const sourceSummary = (row) => {
    if (!row.combined) return `${row.sources.join(" + ")} · ${row.modes.map((m) => MODE_LABELS[m]).join(" + ")}`;
    const { included, of } = row.combined;
    const left = of - included;
    return `${included} Airtable field${included === 1 ? "" : "s"} combined${left ? `, ${left} empty left out` : ""} · ${MODE_LABELS[row.modes[0]]}`;
  };

  const previewTable = (preview, errors) =>
    el("table", { class: "sync-table" }, [
      el("thead", {}, [el("tr", {}, ["Shopify field", "Current", "New", ""].map((h) => el("th", { scope: "col" }, h)))]),
      el("tbody", {}, preview.rows.map((row) => {
        const failed = errors[row.target];
        const pill = failed
          ? el("span", { class: "pill pill--error" }, "Failed")
          : row.action === "set"
            ? el("span", { class: "pill pill--change" }, "Will update")
            : el("span", { class: "pill pill--no" }, row.action === "skip" ? "Skipped" : "No change");
        const partial = row.action === "set" && row.owner === "variant" && `${row.changing} of ${row.of} variants`;
        return el("tr", {}, [
          el("th", { scope: "row" }, [row.label, el("small", { title: row.combined ? row.sources.join(", ") : null }, sourceSummary(row))]),
          el("td", {}, [values(row.current)]),
          el("td", {}, [
            row.action === "set" ? values(row.next) : el("span", { class: "muted" }, "—"),
            (failed || row.reason || partial) && el("small", { class: failed ? "value-error" : "" }, failed || row.reason || partial),
          ]),
          el("td", {}, [pill]),
        ]);
      })),
    ]);

  function render() {
    const retry = el("button", { class: "link-button", type: "button" }, "Try again");
    retry.addEventListener("click", load);
    const note = message && el("p", { class: `status status--${message.kind}` }, message.text);

    if (phase === "idle") {
      const start = el("button", { class: "button button--ghost button--small", type: "button" }, "Preview Shopify update");
      start.addEventListener("click", load);
      return body.replaceChildren(start);
    }
    if (phase === "error") return body.replaceChildren(note, retry);
    if (!data.connected) {
      return body.replaceChildren(
        el("p", { class: "status" }, [`Shopify isn't connected (${data.error}). `, el("a", { href: "/api/shopify/connect" }, "Connect Shopify")])
      );
    }

    const { match, preview } = data;
    const parts = [];
    if (match.status === "none") parts.push(el("p", { class: "status" }, `No Shopify product found. ${match.reason}.`));

    if (match.status === "choose") {
      const cancel = el("button", { class: "link-button", type: "button" }, "Cancel");
      cancel.addEventListener("click", load);
      parts.push(
        el("p", { class: "status" }, ["Choose the Shopify product this box belongs to. It will be remembered. ", choosing && cancel]),
        el("div", { class: "results" }, match.candidates.map((c) => {
          const button = el("button", { class: "result", type: "button" }, [
            thumb(c.image),
            el("div", {}, [el("div", { class: "result__title" }, c.title), el("div", { class: "result__meta" }, productMeta(c))]),
            el("span", { class: `pill ${c.score === 3 ? "pill--yes" : "pill--no"}` }, ["Different colour", "Similar colour", "Close colour", "Same colour"][c.score]),
          ]);
          button.addEventListener("click", () => link(c.id));
          return button;
        }))
      );
    }

    if (match.product) {
      const p = match.product;
      const change = el("button", { class: "link-button", type: "button" }, "Change");
      change.addEventListener("click", choose);
      parts.push(
        el("div", { class: "sync__product" }, [
          thumb(p.image),
          el("div", {}, [
            el("div", { class: "result__title" }, [el("a", { href: p.adminUrl, target: "_blank", rel: "noopener" }, `${p.title} ↗`)]),
            el("div", { class: "result__meta" }, `${MATCH_LABELS[match.method] ?? "Matched"} · ${productMeta(p)}`),
          ]),
          change,
        ])
      );
      if (data.mappingCount === 0) {
        parts.push(el("p", { class: "status" }, ["No field mappings are saved yet. Set them up in ", el("a", { href: "#/mapping" }, "Mapping"), "."]));
      } else if (preview) {
        const go = el("button", { class: "button button--small", type: "button" }, "Update Shopify");
        const dry = el("button", { class: "button button--ghost button--small", type: "button" }, "Dry run");
        go.disabled = dry.disabled = preview.changeCount === 0 || reading;
        go.addEventListener("click", () => update());
        dry.addEventListener("click", () => update({ dryRun: true }));
        const fields = `${preview.changeCount} field${preview.changeCount === 1 ? "" : "s"} will change.`;
        const summary = reading
          ? "Waiting for the PDF to be read."
          : !preview.changeCount
            ? "Nothing to update: Shopify already has these values."
            : data.dryRunOnly
              ? `${fields} This site is in dry run mode, so nothing is written to Shopify.`
              : `${fields} Nothing is written until you update.`;
        const extracts = data.extracts ?? [];
        if (reading) {
          const names = extracts.filter((e) => e.status === "needed").map((e) => `${e.label.toLowerCase()} (${e.filename})`);
          parts.push(el("p", { class: "status" }, `Reading the ${names.join(" and ")}. This takes a minute or two; the preview updates when it's done.`));
        }
        for (const e of extracts.filter((x) => unread.has(x.attachmentId))) {
          parts.push(el("p", { class: "status status--error" }, [`The ${e.label.toLowerCase()} (${e.filename}) couldn't be read, so it's left out: ${unread.get(e.attachmentId)} `, retry]));
        }
        parts.push(
          previewTable(preview, data.result?.errors ?? {}),
          el("div", { class: "sync__actions" }, [!data.dryRunOnly && go, dry, el("span", { class: "muted" }, summary)])
        );
      }
    }
    // After a dry run, the exact requests that an update would send.
    const requests = data.result?.dryRun && data.result.requests;
    const sent = requests
      ? el("details", { class: "sync__requests" }, [
          el("summary", {}, `Show the ${requests.length} request${requests.length === 1 ? "" : "s"} an update would send`),
          ...requests.map((r) => el("pre", {}, `${r.name}\n${JSON.stringify(r.variables, null, 2)}`)),
        ])
      : "";
    body.replaceChildren(...parts, note || "", sent);
  }

  render();
  if (autoLoad) load();
  return { node, load, update, state: snapshot };
}

// The pill a batch row shows for its Shopify state.
function syncPill(s) {
  if (s.phase === "idle") return "";
  if (s.phase === "loading") return el("span", { class: "pill pill--no" }, "Checking…");
  if (s.phase === "error") return el("span", { class: "pill pill--error" }, "Shopify error");
  if (s.reading) return el("span", { class: "pill pill--no" }, "Reading PDF…");
  const [text, kind] = {
    disconnected: ["Not connected", "no"],
    none: ["No Shopify match", "no"],
    choose: ["Choose product", "change"],
    unmapped: ["No mappings", "no"],
  }[s.status] ?? (s.changes ? [`${s.changes} change${s.changes === 1 ? "" : "s"}`, "change"] : ["Up to date", "yes"]);
  // A PDF that couldn't be read is left out of the update, which the row's change count wouldn't show.
  if (s.unread) return el("span", { class: "pill pill--error" }, `${text} · PDF not read`);
  return el("span", { class: `pill pill--${kind}` }, text);
}

// ---------- Value rendering ----------
function renderValue(f, recordId) {
  const v = f.value;
  if (isEmpty(v)) return document.createTextNode("—");
  if (typeof v === "boolean") return document.createTextNode(v ? "Yes" : "No");
  if (typeof v === "object" && !Array.isArray(v)) return renderScalar(v);

  if (Array.isArray(v)) {
    const attachments = v.filter((x) => x && typeof x === "object" && x.url);
    if (attachments.length) {
      return el("div", { class: "attachments" }, attachments.map((a) => {
        const isImage = (a.type || "").startsWith("image/") || a.thumbnails;
        const link = el("a", { class: "attachment", href: safeUrl(a.url), target: "_blank", rel: "noopener", title: a.filename }, [
          isImage && a.thumbnails ? el("img", { src: safeUrl(a.thumbnails.small?.url ?? a.url), alt: a.filename ?? "" }) : a.filename ?? "File",
        ]);
        return a.type === "application/pdf" && a.id ? renderPdfTool(f, a, link, recordId) : link;
      }));
    }
    const items = v.filter((x) => !isEmpty(x));
    if (items.length === 1) return renderScalar(items[0], f);
    return el("div", { class: "chips" }, items.map((x) => el("span", { class: "chip" }, [renderScalar(x, f)])));
  }
  return renderScalar(v, f);
}

// ---------- PDF extraction ----------
const extractKey = (recordId, attachmentId, extract) => `${recordId}:${attachmentId}:${extract}`;
const extractRuns = new Map(); // key -> promise, so two requests for the same PDF share one run

// Has Gemini read a PDF attachment. Resolves with what ends up in state.extracts: the result, or an error.
function runExtract({ recordId, fieldId, attachmentId, extract }) {
  const key = extractKey(recordId, attachmentId, extract);
  // Any "Extract" button on the page for this PDF shows the same progress.
  const repaint = () => document.querySelectorAll(".pdf-extract").forEach((node) => node.dataset.extractKey === key && node.repaint());
  if (!extractRuns.has(key)) {
    state.extracts.set(key, { status: "loading" });
    repaint();
    const work = async () => {
      try {
        const res = await api("/api/pdf/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recordId, fieldId, attachmentId, extract }),
        });
        await api("/api/pdf/extract/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId: res.jobId }),
        });
        let delay = 1000;
        const deadline = Date.now() + 16 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          const job = await api(`/api/pdf/extract?jobId=${encodeURIComponent(res.jobId)}`);
          if (job.status === "done") return { status: "done", ...job.result };
          if (job.status === "error") throw new Error(job.error || "PDF extraction failed");
          delay = Math.min(Math.ceil(delay * 1.5), 5000);
        }
        throw new Error("PDF extraction took too long. Try again.");
      } catch (error) {
        return { status: "done", error: error.message };
      }
    };
    extractRuns.set(key, work().then((result) => {
      state.extracts.set(key, result);
      extractRuns.delete(key);
      repaint();
      return result;
    }));
  }
  return extractRuns.get(key);
}

// A PDF thumbnail with an "Extract" action beside it; the result shows underneath as Markdown.
function renderPdfTool(f, attachment, link, recordId, extract = "tech-pack", label = "Tech pack") {
  const key = extractKey(recordId, attachment.id, extract);
  const button = el("button", { class: "button button--ghost button--small", type: "button" });
  const output = el("div", { class: "pdf-extract__output" });

  const paint = () => {
    const result = state.extracts.get(key);
    button.disabled = result?.status === "loading";
    button.textContent = result?.status === "loading" ? "Extracting…" : result?.markdown ? `Re-extract ${label.toLowerCase()}` : `Extract ${label.toLowerCase()}`;
    if (!result || result.status === "loading") {
      output.replaceChildren(result ? el("p", { class: "status" }, `Queued for extraction: ${attachment.filename ?? "PDF"}…`) : "");
    } else if (result.error) {
      output.replaceChildren(el("p", { class: "status status--error" }, result.error));
    } else {
      const copy = el("button", { class: "link-button", type: "button" }, "Copy Markdown");
      copy.addEventListener("click", async () => {
        await navigator.clipboard.writeText(result.markdown);
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy Markdown"; }, 1500);
      });
      output.replaceChildren(
        el("div", { class: "pdf-extract__bar" }, [el("span", {}, `${label} · ${result.filename} · ${result.model}`), copy]),
        el("pre", { class: "pdf-extract__markdown" }, result.markdown)
      );
    }
  };

  button.addEventListener("click", () => runExtract({ recordId, fieldId: f.id, attachmentId: attachment.id, extract }));

  paint();
  const node = el("div", { class: "pdf-extract", "data-extract-key": key }, [el("div", { class: "pdf-extract__row" }, [link, button]), output]);
  node.repaint = paint;
  return node;
}

function renderScalar(v, f) {
  if (v && typeof v === "object") {
    if (v.linkId) return document.createTextNode(v.name);
    if (v.error) return el("span", { class: "value-error" }, v.error);
    if (v.specialValue) return el("span", { class: "value-error" }, v.specialValue);
    if (v.name) return document.createTextNode(v.name);
    return document.createTextNode(JSON.stringify(v));
  }
  if (typeof v === "number") {
    const isCurrency = f?.type === "currency" || f?.resultType === "currency";
    return document.createTextNode(
      isCurrency
        ? v.toLocaleString("en-AU", { style: "currency", currency: "AUD" })
        : v.toLocaleString("en-AU", { maximumFractionDigits: 2 })
    );
  }
  if (typeof v === "boolean") return document.createTextNode(v ? "Yes" : "No");
  const text = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(text)) {
    const d = new Date(text);
    if (!Number.isNaN(d.getTime())) {
      return document.createTextNode(text.length > 10 ? d.toLocaleString("en-AU") : d.toLocaleDateString("en-AU"));
    }
  }
  return document.createTextNode(text);
}

function typeLabel(f) {
  const map = {
    multipleLookupValues: "Lookup",
    multipleRecordLinks: "Link",
    singleLineText: "Text",
    multilineText: "Long text",
    singleSelect: "Select",
    multipleSelects: "Multi-select",
    multipleAttachments: "Attachment",
    autoNumber: "Auto number",
    createdTime: "Created time",
  };
  let label = map[f.type] ?? f.type.charAt(0).toUpperCase() + f.type.slice(1);
  if (f.linkedTable) label += ` → ${f.linkedTable.trim()}`;
  return label;
}

function isEmpty(v) {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.every(isEmpty);
  return false;
}

function trim(v) {
  return typeof v === "string" ? v.trim() : v ?? null;
}

function safeUrl(url) {
  return typeof url === "string" && url.startsWith("https://") ? url : "";
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "value") node.value = v;
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

init();
