"use strict";

/* ========= config ========= */
const DATA_URL = "data/products.json";

/* ========= tiny dom helper ========= */
const $ = (sel) => document.querySelector(sel);

/* ========= normalization ========= */
function normalizeToken(raw) {
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")   // spaces & punctuation -> _
    .replace(/^_+|_+$/g, "");      // trim leading/trailing _
}

/* ========= query parsing (groups = concepts; OR within a group) ========= */
function simplePluralVariants(tok) {
  const t = normalizeToken(tok);
  const vars = new Set([t]);
  if (t.endsWith("ies")) vars.add(t.slice(0, -3) + "y");   // berries -> berry
  if (t.endsWith("oes")) vars.add(t.slice(0, -2));         // potatoes -> potato
  if (t.endsWith("es"))  vars.add(t.slice(0, -2));         // tomatoes -> tomato
  if (t.endsWith("s"))   vars.add(t.slice(0, -1));         // beans -> bean
  return [...vars];
}

function expandSynonyms(tok) {
  const t = normalizeToken(tok);
  const out = new Set([t]);

  const map = {
    // grains
    grainfree: ["grain_free", "no_grain", "no_grains"],
    "grain-free": ["grain_free", "no_grain", "no_grains"],
    no_grain: ["grain_free"],
    no_grains: ["grain_free"],
    with_grains: ["contains_grain", "grain", "grains"],
    grains: ["contains_grain", "grain"],
    grain: ["contains_grain", "grains"],
    contains_grain: ["contains_grain"],

    // life stage
    puppy: ["puppy"],
    adult: ["adult"],
    senior: ["senior"],

    // protein presence
    protein: ["has_protein", "protein"],
    no_protein: ["no_protein"],

    // brand
    taste: ["taste", "taste_of_the_wild", "totw"],
    totw: ["taste_of_the_wild"],
  };

  if (map[t]) map[t].forEach((x) => out.add(x));
  simplePluralVariants(t).forEach((v) => out.add(v));
  return out;
}

/** Parse query into include GROUPS (OR inside) + global excludes. */
function parseQuery(q) {
  const raw = (q || "").trim();
  if (!raw) return { includeGroups: [], excludes: new Set(), labelIncludes: new Set(), labelExcludes: new Set() };

  const parts = raw.split(/\s+/).filter(Boolean);

  const includeGroups = [];
  const excludes = new Set();
  const labelIncludes = new Set();
  const labelExcludes = new Set();

  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i];
    const isExclude = tok.startsWith("-");
    const base = isExclude ? tok.slice(1) : tok;

    const group = new Set(expandSynonyms(base));

    // bigram support: "sweet potatoes" → "sweet_potatoes"
    if (i + 1 < parts.length && !parts[i + 1].startsWith("-")) {
      const next = parts[i + 1];
      const bigram = normalizeToken(`${base}_${next}`);
      if (bigram) {
        group.add(bigram);
        simplePluralVariants(bigram).forEach((v) => group.add(v));
      }
    }

    if (isExclude) {
      group.forEach((g) => excludes.add(g));
      labelExcludes.add(normalizeToken(base));
    } else {
      includeGroups.push(group);
      labelIncludes.add(normalizeToken(base));
    }
  }

  return { includeGroups, excludes, labelIncludes, labelExcludes };
}

/* ========= tokenization from product ========= */
function explodeSlug(slug) {
  const s = normalizeToken(slug);
  if (!s) return [];
  const parts = [s];
  const idx = s.indexOf("_");
  if (idx > 0) parts.push(s.slice(0, idx)); // "chicken_meal" -> "chicken"
  return parts;
}

function tokensFromString(s) {
  return String(s || "")
    .split(/[\s/_-]+/)
    .map(normalizeToken)
    .filter(Boolean);
}

/** Build a comprehensive token set for a product */
function productTokenSet(product) {
  const T = new Set();

  // id, name, brand
  tokensFromString(product.id).forEach((t) => T.add(t));
  tokensFromString(product.name).forEach((t) => T.add(t));
  tokensFromString(product.brand).forEach((t) => T.add(t));

  // ingredients (full slugs + roots)
  const ingList = String(product.ingredients_list || "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  ingList.forEach((ing) => explodeSlug(ing).forEach((t) => T.add(t)));

  // protein sources
  (product.protein_sources || []).forEach((ps) =>
    explodeSlug(ps).forEach((t) => T.add(t))
  );

  // life stage
  const ls = String(product.life_stage || "").toLowerCase();
  if (ls.includes("puppy")) T.add("puppy");
  if (ls === "adult") T.add("adult");
  if (ls.includes("all life")) {
    T.add("all_life_stages");
    T.add("puppy");
    T.add("adult");
  }

  // grains
  if (product.contains_grain === true) {
    ["contains_grain", "grain", "grains", "with_grains"].forEach((t) => T.add(t));
  } else if (product.contains_grain === false) {
    ["grain_free", "no_grain", "no_grains", "grainfree"].forEach((t) => T.add(t));
  }

  // protein presence
  if ((product.protein_sources || []).length > 0) {
    T.add("has_protein");
    T.add("protein");
  } else {
    T.add("no_protein");
  }

  return T;
}

/** fuzzy-ish membership */
function hasToken(tokenSet, tok) {
  if (tokenSet.has(tok)) return true;
  for (const t of tokenSet) {
    if (t === tok) return true;
    if (t.startsWith(tok + "_")) return true; // chicken -> chicken_meal
    if (t.startsWith(tok)) return true;       // taste -> taste_of_the_wild
  }
  return false;
}

/* ========= scoring: percentage coverage of your include terms =========
   - Each word you type creates a "group".
   - A product gets 1 point if it matches ANY token in that group (OR inside).
   - Score = matchedGroups / totalGroups * 100.
   - We DO NOT require full AND to display; we show partial matches, sorted by score.
*/
function computeMatch(product, includeGroups, excludes) {
  const T = productTokenSet(product);

  // any excluded token present? hide
  for (const ex of excludes) {
    if (hasToken(T, ex)) {
      return { match: 0, matchedGroups: 0, neededGroups: includeGroups.length };
    }
  }

  if (includeGroups.length === 0) {
    return { match: 100, matchedGroups: 0, neededGroups: 0 };
  }

  let matchedGroups = 0;
  for (const group of includeGroups) {
    for (const g of group) {
      if (hasToken(T, g)) {
        matchedGroups += 1;
        break; // group satisfied
      }
    }
  }

  const neededGroups = includeGroups.length;
  const pct = Math.round((matchedGroups / neededGroups) * 100);
  return { match: pct, matchedGroups, neededGroups };
}

/* ========= labels ========= */
function yesNoLabel(val) {
  if (val === true) return "Yes";
  if (val === false) return "No";
  return "—";
}
function lifeStageLabel(v) {
  return v ? String(v) : "—";
}
function proteinPresenceLabel(p) {
  const has = Array.isArray(p?.protein_sources) && p.protein_sources.length > 0;
  return has ? "Yes" : "No";
}

/* ========= rendering ========= */
function renderMeta(total, shown, labelIncludes, labelExcludes) {
  const countEl = $("#countLabel");
  if (countEl) countEl.textContent = `${shown}/${total} shown`;

  const filtersEl = $("#filtersLabel");
  if (filtersEl) {
    const inc = [...(labelIncludes || [])].join(", ");
    const exc = [...(labelExcludes || [])].join(", ");
    filtersEl.textContent = (inc || exc) ? `includes: [${inc}]  excludes: [${exc}]` : "";
  }
}

function makeBadge(k, v, tooltip = "") {
  const b = document.createElement("div");
  b.className = "badge";
  b.innerHTML = `<span class="k">${k}</span><span class="v">${v}</span>`;
  if (tooltip) {
    b.classList.add("has-tooltip");
    b.setAttribute("data-tooltip", tooltip);
  }
  return b;
}

function makeCard(p, res) {
  const { match, matchedGroups, neededGroups } = res;

  const card = document.createElement("article");
  card.className = "card";

  const img = document.createElement("img");
  img.alt = `${p.name} image`;
  img.src = p.image || "";
  card.appendChild(img);

  const body = document.createElement("div");
  body.className = "body";

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = p.name;
  body.appendChild(title);

  const brand = document.createElement("div");
  brand.className = "brand";
  const a = document.createElement("a");
  a.href = p.brand_url || "#";
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = p.brand || "—";
  brand.appendChild(a);
  body.appendChild(brand);

  const badges = document.createElement("div");
  badges.className = "badges";

  // Tooltip for match explains coverage
  const matchTip = neededGroups > 0
    ? `Matched ${matchedGroups} of ${neededGroups} search terms`
    : `No active filters`;
  badges.appendChild(makeBadge("Match", `${match}%`, matchTip));

  // Tooltip for protein sources (shown on hover; your CSS positions it on top)
  const proteinSources = (p.protein_sources || []).join(", ");
  const proteinTooltip = proteinSources ? `Sources: ${proteinSources}` : "";
  badges.appendChild(makeBadge("Protein", proteinPresenceLabel(p), proteinTooltip));

  badges.appendChild(makeBadge("Grains", yesNoLabel(p.contains_grain)));
  badges.appendChild(makeBadge("Life", lifeStageLabel(p.life_stage)));

  body.appendChild(badges);
  card.appendChild(body);
  return card;
}

function render(products, includeGroups, excludes, labelIncludes, labelExcludes) {
  const container = $("#results");
  container.innerHTML = "";

  const scored = products.map((p) => {
    const res = computeMatch(p, includeGroups, excludes);
    return { p, res };
  });

  // Show:
  // - If no includes: show all non-excluded (100% by definition)
  // - If includes: show only items with match > 0 (partial matches allowed), sort by match desc
  const visible = scored
    .filter(({ res }) => (includeGroups.length === 0 ? res.match > 0 : res.match > 0))
    .sort((a, b) => (b.res.match - a.res.match) || a.p.name.localeCompare(b.p.name));

  renderMeta(products.length, visible.length, labelIncludes, labelExcludes);
  visible.forEach(({ p, res }) => container.appendChild(makeCard(p, res)));
}

/* ========= init ========= */
(async function init() {
  const results = $("#results");
  results?.setAttribute("aria-busy", "true");

  let products = [];
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${DATA_URL}: ${res.status}`);
    products = await res.json();
  } catch (err) {
    console.error(err);
    if (results) results.innerHTML = `<p class="muted">Could not load data. Check <code>${DATA_URL}</code>.</p>`;
    return;
  } finally {
    results?.setAttribute("aria-busy", "false");
  }

  const input = $("#query");

  // initial render (no filters)
  render(products, [], new Set(), new Set(), new Set());

  // debounce typing
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const { includeGroups, excludes, labelIncludes, labelExcludes } = parseQuery(input.value);
      render(products, includeGroups, excludes, labelIncludes, labelExcludes);
    }, 150);
  });
})();
