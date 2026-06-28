// Explore view — "the knowledge, navigable" (SPEC-0039 EXPLORE). A read-only, in-app view over the
// evergreen `entities/` graph: a focused entity centered with its directly-linked (1-hop) neighbors,
// each click-to-re-center, with the center's claims inline so exploration leads back to reading
// (EXPLORE-4). Built in "The Line" instrument language (design-system.css primitives) — distinct from
// Obsidian's generic graph (EXPLORE-10). Thin DOM over the typed IPC; the neighborhood assembly is pure
// + node-tested in `kb/explorePanel`. v1 renders a DOM neighborhood (not a force-directed canvas) — the
// thinnest valuable slice (EXPLORE-2); whole-graph + timeline are deferred to v2.
//
// Interactions: search-to-focus + re-center + breadcrumb (EXPLORE-6); typed, confidence-bearing edges
// with a speculative distinction (EXPLORE-5); **filter** the neighborhood by entity kind / edge type /
// "hide speculative" (EXPLORE-9, client-side over the loaded bounded neighborhood); **expand-in-place**
// a neighbor's own links without changing focus (EXPLORE-7, lazy-fetched + cached). The expand reveal
// uses a CSS animation that degrades to instant under prefers-reduced-motion (EXPLORE-13), the same
// reduced-motion discipline as the rest of The Line.
import { esc, emptyState } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import type { ExploreClaim, ExploreContradiction, ExploreEntityRef, ExploreNeighbor, ExploreNeighborhood } from '../../kb/explorePanel';

const HEADER = `<h1 class="explore-title viz-signage">Explore</h1><p class="explore-sub viz-body">Walk your knowledge graph — start at an entity and follow its relationships. Read-only.</p>`;

/** How many neighbors to render in a neighbor's expand-in-place peek (EXPLORE-7) — kept small + bounded. */
const EXPAND_PEEK = 8;

/** The active neighborhood filters (EXPLORE-9). Empty sets = no constraint on that axis. */
interface ExploreFilters {
  kinds: Set<string>; // entity-kind filter (OR within the set)
  edges: Set<string>; // edge-type filter (predicate when present, else the direction descriptor)
  hideSpeculative: boolean; // the optional confidence threshold — drop low-confidence edges
}

/** Per-mount navigation + view state: the focus, the breadcrumb trail, the filters, expanded rows, and
 *  the lazily-fetched data caches (so filter/expand toggles repaint without an IPC round-trip). */
interface ExploreState {
  focus?: string;
  trail: { rel: string; name: string }[];
  filters: ExploreFilters;
  expanded: Set<string>; // neighbor rels currently expanded-in-place
  cache?: { nb: ExploreNeighborhood; entities: readonly ExploreEntityRef[] };
  subCache: Map<string, ExploreNeighborhood>; // neighbor rel → its fetched neighborhood (for expand)
}

function freshFilters(): ExploreFilters {
  return { kinds: new Set(), edges: new Set(), hideSpeculative: false };
}

const DIRECTION_GLYPH: Record<ExploreNeighbor['direction'], string> = { out: '→', in: '←', both: '↔' };
const DIRECTION_LABEL: Record<ExploreNeighbor['direction'], string> = { out: 'links to', in: 'linked from', both: 'mutual link' };
const UNKINDED = 'untyped'; // display label for a neighbor with no kind (legacy/partial data)

/** An edge's type for labelling + filtering (EXPLORE-5/9): its relationship predicate when Connect wrote
 *  one, otherwise the direction descriptor — so every edge has a coherent, filterable type. */
function edgeTypeOf(n: ExploreNeighbor): string {
  const p = n.predicate?.trim();
  return p && p.length > 0 ? p : DIRECTION_LABEL[n.direction];
}

/** An entity's kind for the kind filter — empty/missing kinds collapse to a single UNKINDED bucket. */
function kindKeyOf(n: ExploreNeighbor): string {
  return n.kind && n.kind.trim() ? n.kind : UNKINDED;
}

export async function mountExplore(container: HTMLElement): Promise<void> {
  const state: ExploreState = { trail: [], filters: freshFilters(), expanded: new Set(), subCache: new Map() };
  container.innerHTML = `<div class="explore viz-surface">${HEADER}<p class="viz-body">Loading…</p></div>`;
  await load(container, state);
}

/** Fetch the focused neighborhood + entity list (bounded + error-guarded), cache it, then paint. */
async function load(container: HTMLElement, state: ExploreState): Promise<void> {
  let nb: ExploreNeighborhood;
  let entities: ExploreEntityRef[];
  try {
    // #145-style: bound the whole load→render so a hung/failed IPC degrades to a retryable error,
    // never an infinite spinner.
    [nb, entities] = await Promise.all([withTimeout(window.kbApi.exploreNeighborhood(state.focus)), withTimeout(window.kbApi.exploreEntities())]);
  } catch {
    renderLoadError(container, HEADER, () => void load(container, state));
    return;
  }
  state.cache = { nb, entities };
  paint(container, state);
}

/** Render the current cached neighborhood through the current filter/expand state (no IPC). */
function paint(container: HTMLElement, state: ExploreState): void {
  const cache = state.cache;
  if (!cache) return;
  const { nb, entities } = cache;
  const inner = !nb.found
    ? emptyState({
        title: 'No entities yet.',
        body: 'As you capture and the pipeline connects them, your knowledge graph appears here to explore.',
      })
    : `${searchBar(entities)}${trailBar(state)}${centerCard(nb)}${neighborsBlock(nb, state)}`;
  container.innerHTML = `<div class="explore viz-surface">${HEADER}${inner}</div>`;
  wire(container, state);
}

/** Search-to-focus (EXPLORE-6): an entity-name input with a datalist of all entities for autocomplete. */
function searchBar(entities: readonly ExploreEntityRef[]): string {
  const opts = entities.map((e) => `<option value="${esc(e.name)}"></option>`).join('');
  return `
    <div class="explore-search">
      <label class="explore-search-label viz-field__label viz-signage" for="exploreFocus">Focus</label>
      <input id="exploreFocus" class="explore-focus viz-field__input viz-focusable" type="text" list="exploreEntities" placeholder="Find an entity by name…" autocomplete="off" />
      <datalist id="exploreEntities">${opts}</datalist>
    </div>`;
}

/** Breadcrumb of the path walked (EXPLORE-6: retrace). Each prior focus is a clickable signage crumb. */
function trailBar(state: ExploreState): string {
  if (state.trail.length === 0) return '';
  const crumbs = state.trail
    .map((t, i) => `<button type="button" class="explore-crumb viz-signage viz-focusable" data-rel="${esc(t.rel)}" data-i="${i}">${esc(t.name)}</button>`)
    .join('<span class="explore-crumb-sep" aria-hidden="true">›</span>');
  return `<nav class="explore-trail" aria-label="Explore breadcrumb">${crumbs}<span class="explore-crumb-sep" aria-hidden="true">›</span><span class="explore-crumb explore-crumb--current viz-signage" aria-current="true">here</span></nav>`;
}

/** A node's kind as a tag-colored chip + its confidence (numeric). Shared by the center + neighbors. */
function identity(kind: string, confidence: number): string {
  return `<span class="explore-kind viz-chip">${esc(kind)}</span><span class="explore-conf viz-numeric" title="confidence">${confidence.toFixed(2)}</span>`;
}

/** The focused entity (EXPLORE-4): identity + tags + an open-in-Obsidian affordance + its claims inline.
 *  A contested entity also wears a calm "contested" flag (SPEC-0036 CONTRA-7) above its claims. */
function centerCard(nb: ExploreNeighborhood): string {
  const c = nb.center!;
  const tags = c.tags.length ? `<div class="explore-tags">${c.tags.map((t) => `<span class="explore-tag viz-chip">${esc(t)}</span>`).join('')}</div>` : '';
  const claims = nb.claims.length
    ? `<ul class="explore-claims">${nb.claims.map(renderClaim).join('')}</ul>`
    : `<p class="explore-noclaims viz-body">No claims recorded for this entity yet.</p>`;
  return `
    <div class="explore-center viz-no-chrome viz-spine" data-rel="${esc(c.rel)}">
      <div class="explore-center-head">
        <span class="explore-center-name viz-signage">${esc(c.name)}</span>
        ${identity(c.kind, c.confidence)}
        ${contestedFlag(nb.contradictions)}
        <button type="button" class="explore-open viz-btn viz-btn--ghost viz-focusable" title="Open this entity's note in Obsidian">Open in Obsidian ↗</button>
      </div>
      ${tags}
      ${contestedBanner(nb.contradictions)}
      ${claims}
      <p class="explore-cite-note viz-body" role="status" aria-live="polite"></p>
    </div>`;
}

/** SPEC-0036 CONTRA-7 — a compact "contested" chip on the center head when the entity has open
 *  contradictions (the durable flag). Count in the chip; the conflicting pairs ride in the tooltip. */
function contestedFlag(contradictions: readonly ExploreContradiction[]): string {
  if (contradictions.length === 0) return '';
  const n = contradictions.length;
  const tip = `Unresolved disagreement${n > 1 ? 's' : ''} on this entity — pending your review`;
  return `<span class="explore-contested-flag viz-chip" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="explore-contested-mark" aria-hidden="true">⚠</span> contested${n > 1 ? ` <span class="viz-numeric">${n}</span>` : ''}</span>`;
}

/** SPEC-0036 CONTRA-6/7 — the conflicting statement pairs, shown plainly above the claims so the reader
 *  sees BOTH sides (never one asserted). Read-only; resolution happens in the needs-you queue. */
function contestedBanner(contradictions: readonly ExploreContradiction[]): string {
  if (contradictions.length === 0) return '';
  const rows = contradictions
    .map(
      (x) =>
        `<li class="explore-contested-item viz-body"><span class="explore-contested-side">${esc(x.statements[0])}</span><span class="explore-contested-vs" aria-hidden="true">⟷</span><span class="explore-contested-side">${esc(x.statements[1])}</span></li>`,
    )
    .join('');
  return `
    <div class="explore-contested" role="note" aria-label="Contested facts">
      <span class="explore-contested-head viz-signage"><span class="explore-contested-mark" aria-hidden="true">⚠</span> Sources disagree</span>
      <ul class="explore-contested-list">${rows}</ul>
      <p class="explore-contested-note viz-body">Both are kept and attributed until you resolve this in your review queue.</p>
    </div>`;
}

/** Truncate a source title for the inline citation chip (full title stays in the tooltip/aria-label). */
function clipTitle(s: string): string {
  return s.length > 32 ? s.slice(0, 31) + '…' : s;
}

/**
 * WS-A (SPEC-0046) — render a claim with its statement's `[[Name]]` refs linkified (click → re-center)
 * and its **clickable cited sources** appended (click → openSourceRef). ENG-15/16: a claim with no/empty
 * citations renders cleanly (just the statement); a citation missing a `ref` is skipped; per-claim, so
 * one malformed claim never breaks its siblings.
 */
function renderClaim(cl: ExploreClaim): string {
  const cites = (cl.citations ?? []).filter((c) => c && typeof c.ref === 'string' && c.ref.length > 0);
  const citesHtml = cites.length
    ? ` <span class="explore-cites">${cites
        .map((c) => {
          const title = c.title || 'source';
          return `<button type="button" class="explore-cite viz-focusable" data-ref="${esc(c.ref)}" title="Open source: ${esc(title)}" aria-label="Open source ${esc(title)}"><span class="cite-mark" aria-hidden="true">↗</span> ${esc(clipTitle(title))}</button>`;
        })
        .join('')}</span>`
    : '';
  // SPEC-0036 CONTRA-6: a claim in an open/accepted contradiction wears a "disputed" badge — a non-color
  // signal (the ⚠ glyph + label) so recall never silently asserts a contested fact.
  const disputed = cl.contested
    ? ` <span class="explore-claim-disputed viz-chip" title="This claim is contested — sources disagree" aria-label="disputed — sources disagree"><span class="explore-contested-mark" aria-hidden="true">⚠</span> disputed</span>`
    : '';
  return `<li class="explore-claim viz-body${cl.contested ? ' explore-claim--disputed' : ''}"><span class="explore-claim-status viz-chip" data-status="${esc(cl.status)}">${esc(cl.status)}</span> ${linkifyStatement(cl.statement)} <span class="explore-conf viz-numeric">${cl.confidence.toFixed(2)}</span>${disputed}${citesHtml}</li>`;
}

/**
 * Linkify `[[Name]]` / `[[rel|Name]]` wikilinks in a claim statement into clickable re-center buttons
 * (the resolveProseWikilinks / CONNECT-13 discipline, in the view): the display name is whatever's
 * after a `|` (else the bare inner), and clicking focuses that name (the panel resolves it; an unknown
 * name lands gracefully). The surrounding text is escaped first, so the only HTML we emit is the button
 * around an already-escaped name — a malformed `[[` left in text is harmless (rendered as-is).
 */
function linkifyStatement(statement: string): string {
  return esc(statement).replace(/\[\[([^\]]+)\]\]/g, (whole, inner: string) => {
    const bar = inner.indexOf('|');
    const name = (bar === -1 ? inner : inner.slice(bar + 1)).trim();
    if (!name) return whole;
    return `<button type="button" class="explore-statement-link viz-focusable" data-name="${name}" title="Explore ${name}">${name}</button>`;
  });
}

/** Apply the active filters (EXPLORE-9) to the loaded neighborhood. Empty sets / off = no constraint. */
function applyFilters(neighbors: readonly ExploreNeighbor[], f: ExploreFilters): ExploreNeighbor[] {
  return neighbors.filter((n) => {
    if (f.hideSpeculative && n.speculative) return false;
    if (f.kinds.size > 0 && !f.kinds.has(kindKeyOf(n))) return false;
    if (f.edges.size > 0 && !f.edges.has(edgeTypeOf(n))) return false;
    return true;
  });
}

/** A toggle chip for a filter value (pressed → constraint active). Group + value ride on data attrs. */
function filterChip(group: string, value: string, label: string, pressed: boolean): string {
  return `<button type="button" class="explore-filter-chip viz-chip viz-focusable${pressed ? ' is-on' : ''}" data-group="${esc(group)}" data-value="${esc(value)}" aria-pressed="${pressed}">${esc(label)}</button>`;
}

/**
 * The filter bar (EXPLORE-9): chips for the distinct entity kinds and edge types present in the loaded
 * neighborhood, plus a "hide speculative" toggle. Options are drawn from the FULL loaded set so toggling
 * one never makes the others vanish. Rendered only when there's actually something to narrow (≥2
 * neighbors and a real choice on some axis) — a tiny neighborhood doesn't need a filter bar.
 */
function filterBar(neighbors: readonly ExploreNeighbor[], f: ExploreFilters): string {
  const kinds = [...new Set(neighbors.map(kindKeyOf))].sort((a, b) => a.localeCompare(b));
  const edges = [...new Set(neighbors.map(edgeTypeOf))].sort((a, b) => a.localeCompare(b));
  const anySpeculative = neighbors.some((n) => n.speculative);
  const hasChoice = kinds.length > 1 || edges.length > 1 || anySpeculative;
  if (neighbors.length < 2 || !hasChoice) return '';
  const groups: string[] = [];
  if (kinds.length > 1) {
    groups.push(
      `<div class="explore-filter-group"><span class="explore-filter-label viz-signage">Kind</span>${kinds.map((k) => filterChip('kind', k, k, f.kinds.has(k))).join('')}</div>`,
    );
  }
  if (edges.length > 1) {
    groups.push(
      `<div class="explore-filter-group"><span class="explore-filter-label viz-signage">Edge</span>${edges.map((e) => filterChip('edge', e, e, f.edges.has(e))).join('')}</div>`,
    );
  }
  if (anySpeculative) {
    groups.push(
      `<div class="explore-filter-group">${filterChip('spec', 'hide', 'Hide speculative', f.hideSpeculative)}</div>`,
    );
  }
  const active = f.kinds.size > 0 || f.edges.size > 0 || f.hideSpeculative;
  const clear = active ? `<button type="button" class="explore-filter-clear viz-focusable" title="Clear all filters">clear</button>` : '';
  return `<div class="explore-filters" role="group" aria-label="Filter relationships">${groups.join('')}${clear}</div>`;
}

/** One neighbor row (EXPLORE-5/7): direction glyph + relationship label, name, kind chip, confidence
 *  (speculative-aware), an expand-in-place toggle, and — when expanded — its own links nested inline. */
function neighborRow(n: ExploreNeighbor, state: ExploreState): string {
  const dirLabel = DIRECTION_LABEL[n.direction];
  // The edge label: a Connect predicate ("funds", "owns") when present; otherwise the glyph alone
  // conveys direction (its descriptor stays in the title/aria), keeping the common no-predicate case clean.
  const relLabel = n.predicate ? `<span class="explore-rel viz-numeric" title="relationship">${esc(n.predicate)}</span>` : '';
  // Confidence: `~`-prefixed + brass when speculative — a non-color signal alongside the fade (a11y).
  const confTitle = n.speculative ? 'link confidence — speculative (low)' : 'link confidence';
  const conf = `<span class="explore-conf viz-numeric" title="${confTitle}">${n.speculative ? '~' : ''}${n.confidence.toFixed(2)}</span>`;
  const specClass = n.speculative ? ' explore-neighbor--speculative' : '';
  const recenterTitle = `Explore around ${n.name}${n.speculative ? ' (speculative link)' : ''}`;
  const isOpen = state.expanded.has(n.rel);
  const expandBtn = `<button type="button" class="explore-expand viz-focusable${isOpen ? ' is-open' : ''}" data-rel="${esc(n.rel)}" data-name="${esc(n.name)}" aria-expanded="${isOpen}" title="${isOpen ? 'Collapse' : 'Expand'} ${esc(n.name)}'s links in place"><span aria-hidden="true">${isOpen ? '▾' : '▸'}</span></button>`;
  const sub = isOpen ? expandPeek(n, state) : '';
  return `
      <li class="explore-neighbor${specClass}">
        <div class="explore-neighbor-row">
          ${expandBtn}
          <button type="button" class="explore-recenter viz-no-chrome viz-focusable" data-rel="${esc(n.rel)}" data-name="${esc(n.name)}" title="${esc(recenterTitle)}">
            <span class="explore-edge viz-numeric" title="${esc(dirLabel)}" aria-label="${esc(dirLabel)}">${DIRECTION_GLYPH[n.direction]}</span>
            ${relLabel}
            <span class="explore-neighbor-name viz-body">${esc(n.name)}</span>
            <span class="explore-kind viz-chip">${esc(n.kind)}</span>
            ${conf}
          </button>
        </div>
        ${sub}
      </li>`;
}

/**
 * Expand-in-place (EXPLORE-7): a neighbor's own 1-hop links, revealed inline without changing focus.
 * The neighbor's neighborhood is lazily fetched (cached in `state.subCache`); until it arrives the row
 * shows a brief loading line. Each sub-neighbor is itself click-to-re-center. The reveal animates via a
 * CSS animation that degrades to instant under prefers-reduced-motion (EXPLORE-13).
 */
function expandPeek(n: ExploreNeighbor, state: ExploreState): string {
  const sub = state.subCache.get(n.rel);
  if (!sub) return `<div class="explore-subneighbors viz-body"><span class="explore-sub-loading">Loading ${esc(n.name)}'s links…</span></div>`;
  const subs = sub.neighbors.filter((s) => s.rel !== n.rel).slice(0, EXPAND_PEEK);
  if (subs.length === 0) {
    return `<div class="explore-subneighbors viz-body"><span class="explore-sub-empty">No further links from ${esc(n.name)} yet.</span></div>`;
  }
  const rows = subs
    .map((s) => {
      const label = s.predicate ? ` <span class="explore-rel viz-numeric">${esc(s.predicate)}</span>` : '';
      const spec = s.speculative ? ' explore-neighbor--speculative' : '';
      return `<li class="explore-subneighbor${spec}"><button type="button" class="explore-recenter viz-no-chrome viz-focusable" data-rel="${esc(s.rel)}" data-name="${esc(s.name)}" title="Explore around ${esc(s.name)}"><span class="explore-edge viz-numeric" title="${esc(DIRECTION_LABEL[s.direction])}" aria-label="${esc(DIRECTION_LABEL[s.direction])}">${DIRECTION_GLYPH[s.direction]}</span>${label}<span class="explore-neighbor-name viz-body">${esc(s.name)}</span><span class="explore-kind viz-chip">${esc(s.kind)}</span></button></li>`;
    })
    .join('');
  const more = sub.total > subs.length ? `<li class="explore-sub-more viz-body">+${sub.total - subs.length} more — open ${esc(n.name)} to see all</li>` : '';
  return `<div class="explore-subneighbors"><ul class="explore-subneighbor-list">${rows}${more}</ul></div>`;
}

/** The 1-hop neighborhood (EXPLORE-2/5/7/8/9): filter bar + filtered, expandable, click-to-re-center
 *  rows; bounded to the loaded top-K with a "+N more" overflow note when the hub is large. */
function neighborsBlock(nb: ExploreNeighborhood, state: ExploreState): string {
  if (nb.neighbors.length === 0) {
    // The sparse state (EXPLORE-11): a focused entity with no promoted links renders cleanly, with why.
    return `<div class="explore-neighbors-empty viz-body"><span class="viz-signage explore-neighbors-head">Relationships</span><p>No relationships promoted yet — this entity isn't linked to others in the graph. Connect adds links as it finds them; this view gets richer as that happens.</p></div>`;
  }
  const filtered = applyFilters(nb.neighbors, state.filters);
  const filtersActive = state.filters.kinds.size > 0 || state.filters.edges.size > 0 || state.filters.hideSpeculative;
  const bar = filterBar(nb.neighbors, state.filters);

  // Filters can empty the loaded set — say so plainly, with a clear affordance (never a blank list).
  if (filtered.length === 0) {
    return `
    <div class="explore-neighbors">
      <span class="explore-neighbors-head viz-signage">Relationships</span>
      ${bar}
      <p class="explore-filter-none viz-body">No relationships match these filters. <button type="button" class="explore-filter-clear viz-focusable">Clear filters</button></p>
    </div>`;
  }

  const rows = filtered.map((n) => neighborRow(n, state)).join('');
  // "+N more": unfiltered, the loaded top-K vs the full distinct total (EXPLORE-8). Filtered, the note
  // reflects what the filters hid from the loaded neighborhood instead.
  const overflow = filtersActive
    ? `<p class="explore-more viz-body">Showing ${filtered.length} of ${nb.neighbors.length} loaded${nb.total > nb.neighbors.length ? ` (of ${nb.total} total)` : ''}.</p>`
    : nb.total > nb.shown
      ? `<p class="explore-more viz-body">+${nb.total - nb.shown} more — narrow with a more specific focus.</p>`
      : '';
  const count = filtersActive ? `${filtered.length}/${nb.neighbors.length}` : `${nb.shown}${nb.total > nb.shown ? `/${nb.total}` : ''}`;
  return `
    <div class="explore-neighbors">
      <span class="explore-neighbors-head viz-signage">Relationships <span class="viz-numeric">${count}</span></span>
      ${bar}
      <ul class="explore-neighbor-list">${rows}</ul>
      ${overflow}
    </div>`;
}

function wire(container: HTMLElement, state: ExploreState): void {
  const focusTo = (rel: string | undefined, name: string): void => {
    // Record the current center on the trail before moving (retrace, EXPLORE-6), then re-center. A new
    // focus resets the per-neighborhood view state (filters + expansions don't carry across centers).
    const centerEl = container.querySelector<HTMLElement>('.explore-center');
    const curRel = centerEl?.dataset.rel;
    const curName = container.querySelector('.explore-center-name')?.textContent ?? '';
    if (curRel && curName) state.trail.push({ rel: curRel, name: curName });
    state.focus = rel ?? name;
    resetViewState(state);
    void load(container, state);
  };

  // Search-to-focus: pick from the datalist or type a name + Enter.
  const search = container.querySelector<HTMLInputElement>('.explore-focus');
  const submitSearch = (): void => {
    const v = search?.value.trim();
    if (v) {
      state.trail = []; // a fresh search starts a new path
      state.focus = v;
      resetViewState(state);
      void load(container, state);
    }
  };
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitSearch();
  });
  search?.addEventListener('change', submitSearch); // datalist selection fires change

  // Re-center on a clicked neighbor / sub-neighbor (EXPLORE-6 navigate).
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-recenter'))) {
    btn.addEventListener('click', () => focusTo(btn.dataset.rel, btn.dataset.name ?? ''));
  }

  // Expand-in-place a neighbor's links without changing focus (EXPLORE-7).
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-expand'))) {
    btn.addEventListener('click', () => void toggleExpand(container, state, btn.dataset.rel ?? ''));
  }

  // Filter chips (EXPLORE-9): toggle a value in its group, repaint from cache (no IPC round-trip).
  for (const chip of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-filter-chip'))) {
    chip.addEventListener('click', () => {
      toggleFilter(state, chip.dataset.group ?? '', chip.dataset.value ?? '');
      paint(container, state);
    });
  }
  for (const clr of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-filter-clear'))) {
    clr.addEventListener('click', () => {
      state.filters = freshFilters();
      paint(container, state);
    });
  }

  // Breadcrumb: jump back to a prior focus (truncates the trail to that point).
  for (const crumb of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-crumb[data-rel]'))) {
    crumb.addEventListener('click', () => {
      const i = Number(crumb.dataset.i);
      const target = state.trail[i];
      if (!target) return;
      state.trail = state.trail.slice(0, i);
      state.focus = target.rel;
      resetViewState(state);
      void load(container, state);
    });
  }

  // Open the focused entity's note in Obsidian (EXPLORE-4 click-through; reuses ASK-14 openCitation).
  const openBtn = container.querySelector<HTMLButtonElement>('.explore-open');
  const centerRel = container.querySelector<HTMLElement>('.explore-center')?.dataset.rel;
  openBtn?.addEventListener('click', () => {
    if (centerRel) void window.kbApi.openCitation(centerRel);
  });

  // WS-A: a claim's cited source → open it working-zone-aware (REVIEW-17 openSourceRef); a staging /
  // missing / failed open surfaces an inline note rather than a dead link.
  for (const cite of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-cite'))) {
    cite.addEventListener('click', () => void openSource(container, cite.dataset.ref));
  }

  // WS-A: a `[[Name]]` woven into a claim → re-center on that entity (resolved by name in the panel).
  for (const link of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-statement-link'))) {
    link.addEventListener('click', () => focusTo(undefined, link.dataset.name ?? ''));
  }
}

/** A focus change drops the per-neighborhood view state — filters + expansions are scoped to one center. */
function resetViewState(state: ExploreState): void {
  state.filters = freshFilters();
  state.expanded = new Set();
}

/** Toggle a value in/out of a multi-select filter set. */
function toggleInSet(set: Set<string>, value: string): void {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

/** Toggle a filter value in its group (kind/edge are multi-select sets; spec is a boolean). */
function toggleFilter(state: ExploreState, group: string, value: string): void {
  const f = state.filters;
  if (group === 'kind') toggleInSet(f.kinds, value);
  else if (group === 'edge') toggleInSet(f.edges, value);
  else if (group === 'spec') f.hideSpeculative = !f.hideSpeculative;
}

/**
 * Toggle a neighbor's expand-in-place (EXPLORE-7). Opening lazily fetches its neighborhood once (cached)
 * — a failed fetch degrades to an "unavailable" cache entry rather than throwing (the row stays usable).
 */
async function toggleExpand(container: HTMLElement, state: ExploreState, rel: string): Promise<void> {
  if (!rel) return;
  if (state.expanded.has(rel)) {
    state.expanded.delete(rel);
    paint(container, state);
    return;
  }
  state.expanded.add(rel);
  if (!state.subCache.has(rel)) {
    paint(container, state); // show the loading line immediately
    let sub: ExploreNeighborhood;
    try {
      sub = await withTimeout(window.kbApi.exploreNeighborhood(rel));
    } catch {
      sub = { found: false, claims: [], neighbors: [], shown: 0, total: 0, contradictions: [] }; // degrade to "no further links"
    }
    state.subCache.set(rel, sub);
  }
  paint(container, state);
}

/** Inline messages for a non-`opened` source open (working-zone-aware — REVIEW-17): never a dead link. */
const CITE_STATUS: Record<string, string> = {
  staging: 'That source is still processing — it’ll be in your vault shortly.',
  missing: 'That source isn’t in your vault (it may have been removed).',
  'invalid-ref': 'That source link is invalid.',
  'no-vault': 'No active vault — open a vault to view sources.',
  'open-failed': 'Couldn’t open that source.',
};

/**
 * Open a claim's cited source via the working-zone-aware seam (`openSourceRef` — REVIEW-17): on `main`
 * it opens in Obsidian; staging/missing/failed surface a calm inline note (never a dead link). Never
 * throws — a rejected IPC degrades to the note (ENG-16).
 */
async function openSource(container: HTMLElement, ref: string | undefined): Promise<void> {
  const slot = container.querySelector('.explore-cite-note');
  if (!ref) return;
  let note = '';
  try {
    const res = await window.kbApi.openSourceRef(ref);
    if (res.status !== 'opened') note = CITE_STATUS[res.status] ?? 'Couldn’t open that source.';
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
  }
  if (slot) slot.textContent = note; // cleared (empty) on a successful open
}
