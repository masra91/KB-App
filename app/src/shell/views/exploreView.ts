// Explore view — "the knowledge, navigable" (SPEC-0039 EXPLORE). A read-only, in-app view over the
// evergreen `entities/` graph: a focused entity centered with its directly-linked (1-hop) neighbors,
// each click-to-re-center, with the center's claims inline so exploration leads back to reading
// (EXPLORE-4). Built in "The Line" instrument language (design-system.css primitives) — distinct from
// Obsidian's generic graph (EXPLORE-10). Thin DOM over the typed IPC; the neighborhood assembly is pure
// + node-tested in `kb/explorePanel`. v1 renders a DOM neighborhood (not a force-directed canvas) — the
// thinnest valuable slice (EXPLORE-2); whole-graph + timeline are deferred to v2.
import { esc } from '../html';
import { withTimeout, renderLoadError } from '../loadGuard';
import type { ExploreClaim, ExploreEntityRef, ExploreNeighbor, ExploreNeighborhood } from '../../kb/explorePanel';

const HEADER = `<h1 class="explore-title viz-signage">Explore</h1><p class="explore-sub viz-body">Walk your knowledge graph — start at an entity and follow its relationships. Read-only.</p>`;

/** Per-mount navigation state: the current focus (entity name/rel) + the breadcrumb trail to it. */
interface ExploreState {
  focus?: string;
  trail: { rel: string; name: string }[];
}

const DIRECTION_GLYPH: Record<ExploreNeighbor['direction'], string> = { out: '→', in: '←', both: '↔' };
const DIRECTION_LABEL: Record<ExploreNeighbor['direction'], string> = { out: 'links to', in: 'linked from', both: 'mutual link' };

export async function mountExplore(container: HTMLElement): Promise<void> {
  const state: ExploreState = { trail: [] };
  container.innerHTML = `<div class="explore viz-surface">${HEADER}<p class="viz-body">Loading…</p></div>`;
  await render(container, state);
}

async function render(container: HTMLElement, state: ExploreState): Promise<void> {
  let nb: ExploreNeighborhood;
  let entities: ExploreEntityRef[];
  try {
    // #145-style: bound the whole load→render so a hung/failed IPC degrades to a retryable error,
    // never an infinite spinner.
    [nb, entities] = await Promise.all([withTimeout(window.kbApi.exploreNeighborhood(state.focus)), withTimeout(window.kbApi.exploreEntities())]);
  } catch {
    renderLoadError(container, HEADER, () => void render(container, state));
    return;
  }

  const inner = !nb.found
    ? `<p class="explore-empty viz-body">No entities yet. As you capture and the pipeline connects them, your knowledge graph appears here to explore.</p>`
    : `${searchBar(entities)}${trailBar(state)}${centerCard(nb)}${neighborsBlock(nb)}`;
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

/** The focused entity (EXPLORE-4): identity + tags + an open-in-Obsidian affordance + its claims inline. */
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
        <button type="button" class="explore-open viz-btn viz-btn--ghost viz-focusable" title="Open this entity's note in Obsidian">Open in Obsidian ↗</button>
      </div>
      ${tags}
      ${claims}
      <p class="explore-cite-note viz-body" role="status" aria-live="polite"></p>
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
  return `<li class="explore-claim viz-body"><span class="explore-claim-status viz-chip" data-status="${esc(cl.status)}">${esc(cl.status)}</span> ${linkifyStatement(cl.statement)} <span class="explore-conf viz-numeric">${cl.confidence.toFixed(2)}</span>${citesHtml}</li>`;
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

/** The 1-hop neighborhood (EXPLORE-2/5/8): each neighbor a click-to-re-center row, with the edge
 *  direction; bounded to top-K with a "+N more" overflow note when the hub is large. */
function neighborsBlock(nb: ExploreNeighborhood): string {
  if (nb.neighbors.length === 0) {
    // The sparse state (EXPLORE-11): a focused entity with no promoted links renders cleanly, with why.
    return `<div class="explore-neighbors-empty viz-body"><span class="viz-signage explore-neighbors-head">Relationships</span><p>No relationships promoted yet — this entity isn't linked to others in the graph. Connect adds links as it finds them; this view gets richer as that happens.</p></div>`;
  }
  const rows = nb.neighbors
    .map(
      (n) => `
      <li class="explore-neighbor">
        <button type="button" class="explore-recenter viz-no-chrome viz-focusable" data-rel="${esc(n.rel)}" data-name="${esc(n.name)}" title="Explore around ${esc(n.name)}">
          <span class="explore-edge viz-numeric" title="${esc(DIRECTION_LABEL[n.direction])}" aria-label="${esc(DIRECTION_LABEL[n.direction])}">${DIRECTION_GLYPH[n.direction]}</span>
          <span class="explore-neighbor-name viz-body">${esc(n.name)}</span>
          ${identity(n.kind, n.confidence)}
        </button>
      </li>`,
    )
    .join('');
  const overflow = nb.total > nb.shown ? `<p class="explore-more viz-body">+${nb.total - nb.shown} more — narrow with a more specific focus.</p>` : '';
  return `
    <div class="explore-neighbors">
      <span class="explore-neighbors-head viz-signage">Relationships <span class="viz-numeric">${nb.shown}${nb.total > nb.shown ? `/${nb.total}` : ''}</span></span>
      <ul class="explore-neighbor-list">${rows}</ul>
      ${overflow}
    </div>`;
}

function wire(container: HTMLElement, state: ExploreState): void {
  const focusTo = (rel: string | undefined, name: string): void => {
    // Record the current center on the trail before moving (retrace, EXPLORE-6), then re-center.
    const centerEl = container.querySelector<HTMLElement>('.explore-center');
    const curRel = centerEl?.dataset.rel;
    const curName = container.querySelector('.explore-center-name')?.textContent ?? '';
    if (curRel && curName) state.trail.push({ rel: curRel, name: curName });
    state.focus = rel ?? name;
    void render(container, state);
  };

  // Search-to-focus: pick from the datalist or type a name + Enter.
  const search = container.querySelector<HTMLInputElement>('.explore-focus');
  const submitSearch = (): void => {
    const v = search?.value.trim();
    if (v) {
      state.trail = []; // a fresh search starts a new path
      state.focus = v;
      void render(container, state);
    }
  };
  search?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitSearch();
  });
  search?.addEventListener('change', submitSearch); // datalist selection fires change

  // Re-center on a clicked neighbor (EXPLORE-6 navigate).
  for (const btn of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-recenter'))) {
    btn.addEventListener('click', () => focusTo(btn.dataset.rel, btn.dataset.name ?? ''));
  }

  // Breadcrumb: jump back to a prior focus (truncates the trail to that point).
  for (const crumb of Array.from(container.querySelectorAll<HTMLButtonElement>('.explore-crumb[data-rel]'))) {
    crumb.addEventListener('click', () => {
      const i = Number(crumb.dataset.i);
      const target = state.trail[i];
      if (!target) return;
      state.trail = state.trail.slice(0, i);
      state.focus = target.rel;
      void render(container, state);
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
