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
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/* ========= query parsing ========= */
function simplePluralVariants(tok) {
  const t = normalizeToken(tok);
  const vars = new Set([t]);
  if (t.endsWith("ies")) vars.add(t.slice(0, -3) + "y");
  if (t.endsWith("oes")) vars.add(t.slice(0, -2));
  if (t.endsWith("es")) vars.add(t.slice(0, -2));
  if (t.endsWith("s")) vars.add(t.slice(0, -1));
  return [...vars];
}

function expandSynonyms(tok) {
  const t = normalizeToken(tok);
  const out = new Set([t]);
  const map = {
    grainfree: ["grain_free", "no_grain", "no_grains"],
    "grain-free": ["grain_free", "no_grain", "no_grains"],
    no_grain: ["grain_free"],
    no_grains: ["grain_free"],
    with_grains: ["contains_grain", "grain", "grains"],
    grains: ["contains_grain", "grain"],
    grain: ["contains_grain", "grains", "with_grains"],
    contains_grain: ["contains_grain"],
    protein: ["has_protein", "protein"],
    no_protein: ["no_protein"],
    taste: ["taste", "taste_of_the_wild", "totw"],
    totw: ["taste_of_the_wild"],
  };
  if (map[t]) map[t].forEach((x) => out.add(x));
  simplePluralVariants(t).forEach((v) => out.add(v));
  return out;
}

/* ========= Parse user query ========= */
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

    // bigram support
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
  if (idx > 0) parts.push(s.slice(0, idx));
  return parts;
}

function tokensFromString(s) {
  return String(s || "")
    .split(/[\s/_-]+/)
    .map(normalizeToken)
    .filter(Boolean);
}

/* ========= build token set ========= */
function productTokenSet(product) {
  const T = new Set();
  tokensFromString(product.id).forEach((t) => T.add(t));
  tokensFromString(product.name).forEach((t) => T.add(t));
  tokensFromString(product.brand).forEach((t) => T.add(t));
  const ingList = String(product.ingredients_list || "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  ingList.forEach((ing) => explodeSlug(ing).forEach((t) => T.add(t)));
  (product.protein_sources || []).forEach((ps) => explodeSlug(ps).forEach((t) => T.add(t)));
  if (product.contains_grain === true) {
    ["contains_grain", "grain", "grains", "with_grains"].forEach((t) => T.add(t));
  } else if (product.contains_grain === false) {
    ["grain_free", "no_grain", "no_grains", "grainfree"].forEach((t) => T.add(t));
  }
  if ((product.protein_sources || []).length > 0) {
    T.add("has_protein");
    T.add("protein");
  } else {
    T.add("no_protein");
  }
  return T;
}

/* ========= compute match % ========= */
function hasToken(tokenSet, tok) {
  if (tokenSet.has(tok)) return true;
  for (const t of tokenSet) {
    if (t === tok || t.startsWith(tok + "_") || t.startsWith(tok)) return true;
  }
  return false;
}

/* Special-case exclude matcher so -grain/-grains do NOT exclude grain-free by prefix */
function hasTokenExclude(tokenSet, tok) {
  const tkn = normalizeToken(tok);

  // Special-case: avoid excluding grain-free when user types -grain / -grains
  if (tkn === "grain" || tkn === "grains") {
    return (
      tokenSet.has("contains_grain") ||
      tokenSet.has("grain") ||
      tokenSet.has("grains") ||
      tokenSet.has("with_grains")
    );
  }

  // For other excludes: exact or root_withSuffix (e.g., -chicken hides chicken_meal)
  for (const t of tokenSet) {
    if (t === tkn || t.startsWith(tkn + "_")) return true;
  }
  return false;
}

const PROTEIN_DESCRIPTOR_PREFIXES = [
  "deboned_",
  "roasted_",
  "smoke_flavored_",
  "freeze_dried_",
  "air_dried_",
  "oven_baked_",
  "wild_caught_",
  "farm_raised_",
  "free_range_",
  "cage_free_",
  "real_",
  "fresh_",
  "raw_",
  "ground_",
  "dried_",
];

const PROTEIN_SUFFIX_FORMS = [
  { suffix: "_meal", form: "meal" },
  { suffix: "_meals", form: "meal" },
  { suffix: "_fat", form: "fat" },
  { suffix: "_oil", form: "fat" },
  { suffix: "_tallow", form: "fat" },
  { suffix: "_grease", form: "fat" },
  { suffix: "_product", form: "other" },
  { suffix: "_products", form: "other" },
  { suffix: "_liver", form: "other" },
  { suffix: "_heart", form: "other" },
  { suffix: "_kidney", form: "other" },
  { suffix: "_lung", form: "other" },
  { suffix: "_tripe", form: "other" },
  { suffix: "_giblets", form: "other" },
  { suffix: "_plasma", form: "other" },
  { suffix: "_egg", form: "other" },
  { suffix: "_eggs", form: "other" },
  { suffix: "_whites", form: "other" },
  { suffix: "_breast", form: "other" },
  { suffix: "_and_bone", form: "other" },
];

function stripProteinPrefix(name) {
  let value = name;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of PROTEIN_DESCRIPTOR_PREFIXES) {
      if (value.startsWith(prefix)) {
        value = value.slice(prefix.length);
        changed = true;
        break;
      }
    }
  }
  return value;
}

function parseProteinSource(raw) {
  let norm = normalizeToken(raw);
  if (!norm) return null;
  norm = stripProteinPrefix(norm);

  let form = "pure";
  for (const { suffix, form: f } of PROTEIN_SUFFIX_FORMS) {
    if (norm.endsWith(suffix)) {
      norm = norm.slice(0, -suffix.length);
      form = f;
      break;
    }
  }

  if (!norm) {
    norm = normalizeToken(raw);
  }

  return {
    base: norm,
    form,
    mixed: norm.includes("_and_") || norm.includes("_with_") || norm.includes("_plus_"),
  };
}

function evaluateProteinPurity(proteinSources) {
  const parsed = (proteinSources || [])
    .map(parseProteinSource)
    .filter(Boolean);

  if (parsed.length === 0) {
    return { percent: 0, tier: "none" };
  }

  const byBase = new Map();
  let anyMixed = false;
  for (const item of parsed) {
    if (!byBase.has(item.base)) {
      byBase.set(item.base, { forms: new Set(), count: 0 });
    }
    const stats = byBase.get(item.base);
    stats.forms.add(item.form);
    stats.count += 1;
    if (item.mixed) anyMixed = true;
  }

  const baseEntries = [...byBase.entries()].sort((a, b) => b[1].count - a[1].count);
  const primary = baseEntries[0];
  const primaryForms = new Set(primary ? [...primary[1].forms] : []);
  const otherBases = baseEntries.slice(1);
  const otherBaseHasNonFat = otherBases.some(([, stats]) => {
    for (const f of stats.forms) {
      if (f !== "fat") return true;
    }
    return false;
  });
  const otherBaseExists = otherBases.length > 0;
  const primaryOnlyPure = primaryForms.size === 1 && primaryForms.has("pure");
  const primaryOnlyPureOrMeal = [...primaryForms].every((f) => f === "pure" || f === "meal");
  const primaryHasFat = primaryForms.has("fat");
  const primaryHasOther = [...primaryForms].some((f) => f === "other");

  let percent = 75;
  let tier = "mixed";

  if (anyMixed || otherBaseHasNonFat) {
    percent = 75;
    tier = "mixed";
  } else if (!otherBaseExists && primaryOnlyPure) {
    percent = 100;
    tier = "pure";
  } else if (!otherBaseExists && primaryOnlyPureOrMeal && !primaryHasFat && !primaryHasOther) {
    percent = 93;
    tier = "meal";
  } else if (
    (!otherBaseExists && (primaryHasFat || primaryHasOther)) ||
    (otherBaseExists && !otherBaseHasNonFat)
  ) {
    percent = 85;
    tier = "fat";
  }

  return { percent, tier };
}

function computeMatch(product, includeGroups, excludes) {
  const T = productTokenSet(product);

  for (const ex of excludes) {
    if (hasTokenExclude(T, ex)) {
      return {
        match: 0,
        sortScore: 0,
        matchedGroups: 0,
        neededGroups: includeGroups.length,
        show: false,
      };
    }
  }

  const neededGroups = includeGroups.length;
  let matchedGroups = 0;

  for (const group of includeGroups) {
    const matched = [...group].some((g) => hasToken(T, normalizeToken(g)));
    if (matched) matchedGroups += 1;
  }

  if (neededGroups > 0 && matchedGroups === 0) {
    return {
      match: 0,
      sortScore: 0,
      matchedGroups,
      neededGroups,
      show: false,
    };
  }

  const matchPercent = neededGroups === 0 ? 0 : Math.round((matchedGroups / neededGroups) * 100);

  return {
    match: matchPercent,
    sortScore: matchPercent,
    matchedGroups,
    neededGroups,
    show: true,
  };
}


/* ========= helpers ========= */
function yesNoLabel(val) {
  if (val === true) return "Yes";
  if (val === false) return "No";
  return "—";
}
function proteinPresenceLabel(p) {
  const has = Array.isArray(p?.protein_sources) && p.protein_sources.length > 0;
  return has ? "Yes" : "No";
}

/* ========= popup ========= */
function openIngredientsPopup(product) {
  const existing = document.querySelector(".ingredients-popup");
  if (existing) existing.remove();

  let ingredientsText = product.ingredients_list || "No ingredients listed.";
  ingredientsText = ingredientsText
    .split(/[;,\n]+/)
    .map(x => x.trim().replace(/_/g, " "))
    .filter(Boolean)
    .join(", ");

  const overlay = document.createElement("div");
  overlay.className = "ingredients-popup";
  overlay.innerHTML = `
    <div class="popup-content">
      <h2>${product.name}</h2>
      <p class="brand">${product.brand}</p>
      <div class="ingredients-body">${ingredientsText}</div>
      <button class="close-popup">Close</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector(".close-popup").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}

/* ========= render cards ========= */
function makeCard(p, res) {
  const { match } = res;
  const card = document.createElement("article");
  card.className = "card";

  const header = document.createElement("div");
  header.className = "header";

  const brand = document.createElement("div");
  brand.className = "brand";
  const a = document.createElement("a");
  a.href = p.brand_url || "#";
  a.target = "_blank";
  a.rel = "noopener";
  a.textContent = p.brand || "—";
  brand.appendChild(a);
  header.appendChild(brand);

  const title = document.createElement("div");
  title.className = "title";
  const shortName = p.name.split(" ").slice(0, 3).join(" ");
  title.textContent = shortName;
  title.classList.add("has-title-tooltip");
  title.setAttribute("data-title-tooltip", p.name);
  header.appendChild(title);
  card.appendChild(header);

  const content = document.createElement("div");
  content.className = "content";
  const img = document.createElement("img");
  img.alt = `${p.name} image`;
  img.src = p.image || "";
  content.appendChild(img);

  const badges = document.createElement("div");
  badges.className = "badges";

  const matchBadge = document.createElement("div");
  matchBadge.className = "badge match";
  const matchValue = Number.isFinite(match) ? Math.round(match) : match;
  matchBadge.textContent = `${matchValue}% Match`;
  const matchTip = res.neededGroups > 0
    ? `Matched ${res.matchedGroups} of ${res.neededGroups} search terms`
    : "No active filters";
  matchBadge.classList.add("has-badge-tooltip");
  matchBadge.setAttribute("data-badge-tooltip", matchTip);
  if (res.tier) {
    matchBadge.setAttribute("data-match-tier", res.tier);
  }
  badges.appendChild(matchBadge);

  const proteinBadge = document.createElement("div");
  proteinBadge.className = "badge";
  proteinBadge.textContent = `Protein`;
  if (Array.isArray(p.protein_sources) && p.protein_sources.length > 0) {
    const sources = p.protein_sources.map(src => src.replace(/_/g, " ")).join(", ");
    proteinBadge.classList.add("has-badge-tooltip");
    proteinBadge.setAttribute("data-badge-tooltip", sources);
  }
  badges.appendChild(proteinBadge);

  const grainsBadge = document.createElement("div");
  grainsBadge.className = "badge";
  grainsBadge.textContent = `Grains: ${yesNoLabel(p.contains_grain)}`;
  badges.appendChild(grainsBadge);

  content.appendChild(badges);
  card.appendChild(content);

  const ingBtn = document.createElement("button");
  ingBtn.className = "pf-ingredients-btn";
  ingBtn.textContent = "Ingredients";
  ingBtn.addEventListener("click", () => openIngredientsPopup(p));
  card.appendChild(ingBtn);

  return card;
}

/* ========= render main ========= */
function renderMeta(total, shown, labelIncludes, labelExcludes) {
  const countEl = $("#countLabel");
  if (countEl) {
    countEl.textContent = total === 0 && shown === 0 ? "" : `${shown}/${total} shown`;
  }
  const filtersEl = $("#filtersLabel");
  if (filtersEl) {
    const inc = [...(labelIncludes || [])].join(", ");
    const exc = [...(labelExcludes || [])].join(", ");
    filtersEl.textContent = (inc || exc) ? `includes: [${inc}]  excludes: [${exc}]` : "";
  }
}

function render(products, includeGroups, excludes, labelIncludes, labelExcludes) {
  const container = $("#results");
  container.innerHTML = "";

  const hasQuery = includeGroups.length > 0 || excludes.size > 0;
  if (!hasQuery) {
    container.innerHTML = '<p class="muted instructions">start typing to see matches</p>';
    renderMeta(0, 0, labelIncludes, labelExcludes);
    return;
  }

  const scored = products.map((p) => ({ p, res: computeMatch(p, includeGroups, excludes) }));
  const filtered = scored
    .filter(({ res }) => res.show !== false)
    .sort((a, b) => b.res.sortScore - a.res.sortScore || a.p.name.localeCompare(b.p.name));
  const limited = filtered.slice(0, 6);

  renderMeta(filtered.length, limited.length, labelIncludes, labelExcludes);

  if (limited.length === 0) {
    container.innerHTML = '<p class="muted">No matches found.</p>';
    return;
  }

  limited.forEach(({ p, res }) => container.appendChild(makeCard(p, res)));
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
    if (results)
      results.innerHTML = `<p class="muted">Could not load data. Check <code>${DATA_URL}</code>.</p>`;
    return;
  } finally {
    results?.setAttribute("aria-busy", "false");
  }

  const input = $("#query");
  const fetchBtn = $("#fetchBtn");
  const clearBtn = $("#clearBtn");

  // Initial render
  render(products, [], new Set(), new Set(), new Set());

  // Typing search
  let t;
  input.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const { includeGroups, excludes, labelIncludes, labelExcludes } = parseQuery(input.value);
      render(products, includeGroups, excludes, labelIncludes, labelExcludes);
    }, 150);
  });

  // Fetch button — triggers search immediately
  fetchBtn.addEventListener("click", () => {
    const { includeGroups, excludes, labelIncludes, labelExcludes } = parseQuery(input.value);
    render(products, includeGroups, excludes, labelIncludes, labelExcludes);
  });

  // Clear button — resets everything
  clearBtn.addEventListener("click", () => {
    input.value = "";
    render(products, [], new Set(), new Set(), new Set());
  });

  
})();

