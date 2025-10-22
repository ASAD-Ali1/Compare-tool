"use strict";

/* ========= config ========= */
const DATA_URL = "data/products.json";

/* ========= tiny DOM helpers ========= */
const $ = (sel, ctx = document) => ctx.querySelector(sel);
const create = (tag, options = {}) =>
  Object.assign(document.createElement(tag), options);

/* ========= normalization ========= */
const normalizeToken = (raw) =>
  String(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

/* ========= query parsing ========= */
const simplePluralVariants = (tok) => {
  const t = normalizeToken(tok);
  const variants = new Set([t]);
  const endings = [
    ["ies", (val) => val.slice(0, -3) + "y"],
    ["oes", (val) => val.slice(0, -2)],
    ["es", (val) => val.slice(0, -2)],
    ["s", (val) => val.slice(0, -1)],
  ];
  endings.forEach(([suffix, fn]) => t.endsWith(suffix) && variants.add(fn(t)));
  return [...variants];
};

const SYNONYMS = {
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

const expandSynonyms = (tok) => {
  const base = normalizeToken(tok);
  const variants = new Set([base]);
  (SYNONYMS[base] || []).forEach((value) => variants.add(value));
  simplePluralVariants(base).forEach((value) => variants.add(value));
  return variants;
};

/* ========= Parse user query ========= */
const emptyParseResult = () => ({
  includeGroups: [],
  excludes: new Set(),
  labelIncludes: new Set(),
  labelExcludes: new Set(),
});

const parseQuery = (q) => {
  const parts = String(q || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return emptyParseResult();

  const includeGroups = [];
  const excludes = new Set();
  const labelIncludes = new Set();
  const labelExcludes = new Set();

  parts.forEach((raw, index) => {
    const isExclude = raw.startsWith("-");
    const base = isExclude ? raw.slice(1) : raw;
    const group = new Set(expandSynonyms(base));

    const next = parts[index + 1];
    if (next && !next.startsWith("-")) {
      const bigram = normalizeToken(`${base}_${next}`);
      if (bigram) {
        group.add(bigram);
        simplePluralVariants(bigram).forEach((value) => group.add(value));
      }
    }

    const labelTarget = isExclude ? labelExcludes : labelIncludes;
    labelTarget.add(normalizeToken(base));

    if (isExclude) {
      group.forEach((token) => excludes.add(token));
    } else {
      includeGroups.push(group);
    }
  });

  return { includeGroups, excludes, labelIncludes, labelExcludes };
};

/* ========= tokenization from product ========= */
const explodeSlug = (slug) => {
  const normalized = normalizeToken(slug);
  if (!normalized) return [];
  const idx = normalized.indexOf("_");
  return idx > 0 ? [normalized, normalized.slice(0, idx)] : [normalized];
};

const tokensFromString = (value) =>
  String(value || "")
    .split(/[\s/_-]+/)
    .map(normalizeToken)
    .filter(Boolean);

/* ========= build token set ========= */
const addTokens = (target, tokens) => tokens.forEach((token) => target.add(token));

const productTokenSet = (product) => {
  const { id, name, brand, contains_grain, protein_sources = [], ingredients_list = "" } = product;
  const tokens = new Set();

  [id, name, brand].forEach((value) => addTokens(tokens, tokensFromString(value)));

  ingredients_list
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((ingredient) => addTokens(tokens, explodeSlug(ingredient)));

  protein_sources.forEach((source) => addTokens(tokens, explodeSlug(source)));

  const grainTokens =
    contains_grain === true
      ? ["contains_grain", "grain", "grains", "with_grains"]
      : contains_grain === false
      ? ["grain_free", "no_grain", "no_grains", "grainfree"]
      : [];
  addTokens(tokens, grainTokens);

  addTokens(tokens, protein_sources.length ? ["has_protein", "protein"] : ["no_protein"]);

  return tokens;
};

/* ========= compute match % ========= */
const hasToken = (tokenSet, token) => {
  if (tokenSet.has(token)) return true;
  for (const value of tokenSet) {
    if (value === token || value.startsWith(token + "_") || value.startsWith(token)) return true;
  }
  return false;
};

/* Special-case exclude matcher so -grain/-grains do NOT exclude grain-free by prefix */
const hasTokenExclude = (tokenSet, tok) => {
  const token = normalizeToken(tok);
  if (token === "grain" || token === "grains") {
    return ["contains_grain", "grain", "grains", "with_grains"].some((value) => tokenSet.has(value));
  }
  for (const value of tokenSet) {
    if (value === token || value.startsWith(`${token}_`)) return true;
  }
  return false;
};

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

const stripProteinPrefix = (name) => {
  let value = name;
  let searching = true;
  while (searching) {
    searching = false;
    for (const prefix of PROTEIN_DESCRIPTOR_PREFIXES) {
      if (value.startsWith(prefix)) {
        value = value.slice(prefix.length);
        searching = true;
        break;
      }
    }
  }
  return value;
};

const parseProteinSource = (raw) => {
  let norm = normalizeToken(raw);
  if (!norm) return null;

  norm = stripProteinPrefix(norm);

  let form = "pure";
  for (const { suffix, form: type } of PROTEIN_SUFFIX_FORMS) {
    if (norm.endsWith(suffix)) {
      norm = norm.slice(0, -suffix.length);
      form = type;
      break;
    }
  }

  if (!norm) norm = normalizeToken(raw);

  return {
    base: norm,
    form,
    mixed: /_(and|with|plus)_/.test(norm),
  };
};

function evaluateProteinPurity(proteinSources) {
  const parsed = (proteinSources || []).map(parseProteinSource).filter(Boolean);
  if (!parsed.length) return { percent: 0, tier: "none" };

  const byBase = parsed.reduce((acc, item) => {
    if (!acc.has(item.base)) acc.set(item.base, { forms: new Set(), count: 0 });
    const data = acc.get(item.base);
    data.forms.add(item.form);
    data.count += 1;
    return acc;
  }, new Map());

  const entries = [...byBase.entries()].sort((a, b) => b[1].count - a[1].count);
  const [primary] = entries;
  const otherBases = entries.slice(1);
  const primaryForms = new Set(primary ? primary[1].forms : []);
  const otherBaseHasNonFat = otherBases.some(([, stats]) => [...stats.forms].some((f) => f !== "fat"));
  const otherBaseExists = otherBases.length > 0;

  const primaryOnlyPure = primaryForms.size === 1 && primaryForms.has("pure");
  const primaryOnlyPureOrMeal = [...primaryForms].every((f) => f === "pure" || f === "meal");
  const primaryHasFat = primaryForms.has("fat");
  const primaryHasOther = [...primaryForms].some((f) => f === "other");
  const anyMixed = parsed.some((item) => item.mixed);

  if (anyMixed || otherBaseHasNonFat) return { percent: 75, tier: "mixed" };
  if (!otherBaseExists && primaryOnlyPure) return { percent: 100, tier: "pure" };
  if (!otherBaseExists && primaryOnlyPureOrMeal && !primaryHasFat && !primaryHasOther)
    return { percent: 93, tier: "meal" };
  if ((!otherBaseExists && (primaryHasFat || primaryHasOther)) || (otherBaseExists && !otherBaseHasNonFat))
    return { percent: 85, tier: "fat" };
  return { percent: 75, tier: "mixed" };
}

const ingredientTokens = (product) => {
  const tokens = [];

  const addToken = (value) => {
    const normalized = normalizeToken(value);
    if (!normalized) return;
    tokens.push(normalized);
  };

  String(product.ingredients_list || "")
    .split(/[;,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => addToken(item));

  (product.protein_sources || []).forEach((source) => addToken(source));

  return tokens;
};

const countTokenMatches = (tokenList, rawToken) => {
  const token = normalizeToken(rawToken);
  if (!token) return 0;

  return tokenList.reduce((total, value) => {
    if (value === token) return total + 1;
    if (!token.includes("_") && value.split("_").includes(token)) return total + 1;
    return total;
  }, 0);
};

const computeMatch = (product, includeGroups, excludes) => {
  const tokens = productTokenSet(product);
  const frequencyTokens = ingredientTokens(product);

  for (const ex of excludes) {
    if (hasTokenExclude(tokens, ex)) {
      return { match: 0, sortScore: 0, matchedGroups: 0, neededGroups: includeGroups.length, show: false };
    }
  }

  const neededGroups = includeGroups.length;
  const matchedGroups = includeGroups.filter((group) => [...group].some((token) => hasToken(tokens, normalizeToken(token)))).length;

  if (neededGroups > 0 && matchedGroups === 0)
    return { match: 0, sortScore: 0, matchedGroups, neededGroups, show: false };

  const match = neededGroups === 0 ? 0 : Math.round((matchedGroups / neededGroups) * 100);

  const frequencyScore = includeGroups.reduce((score, group) => {
    let groupCount = 0;
    group.forEach((token) => {
      groupCount = Math.max(groupCount, countTokenMatches(frequencyTokens, token));
    });
    return score + groupCount;
  }, 0);

  const sortScore = match * 1000 + frequencyScore;

  return { match, sortScore, matchedGroups, neededGroups, show: true };
};


/* ========= helpers ========= */
const yesNoLabel = (value) => (value === true ? "Yes" : value === false ? "No" : "—");

/* ========= popup ========= */
const openIngredientsPopup = (product) => {
  $(".ingredients-popup")?.remove();

  const ingredientsText = (product.ingredients_list || "No ingredients listed.")
    .split(/[;,\n]+/)
    .map((value) => value.trim().replace(/_/g, " "))
    .filter(Boolean)
    .join(", ");

  const overlay = create("div", { className: "ingredients-popup" });
  overlay.innerHTML = `
    <div class="popup-content">
      <h2>${product.name}</h2>
      <p class="brand">${product.brand}</p>
      <div class="ingredients-body">${ingredientsText}</div>
      <button class="close-popup">Close</button>
    </div>
  `;
  document.body.append(overlay);
  $(".close-popup", overlay)?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (event) => event.target === overlay && overlay.remove());
};

/* ========= render cards ========= */
const makeBadge = (text, { tooltip, className = "" } = {}) => {
  const badge = create("div", { className: `badge ${className}`.trim(), textContent: text });
  if (tooltip) {
    badge.classList.add("has-badge-tooltip");
    badge.dataset.badgeTooltip = tooltip;
  }
  return badge;
};

const makeCard = (product, result) => {
  const card = create("article", { className: "card" });

  const header = create("div", { className: "header" });
  const brandLink = create("a", {
    href: product.brand_url || "#",
    target: "_blank",
    rel: "noopener",
    textContent: product.brand || "—",
  });
  header.append(create("div", { className: "brand" }), create("div", { className: "title" }));
  $(".brand", header).append(brandLink);

  const title = $(".title", header);
  const shortName = product.name.split(" ").slice(0, 3).join(" ");
  title.textContent = shortName;
  title.classList.add("has-title-tooltip");
  title.dataset.titleTooltip = product.name;

  const content = create("div", { className: "content" });
  const img = create("img", { src: product.image || "", alt: `${product.name} image` });
  const badges = create("div", { className: "badges" });

  const matchValue = Number.isFinite(result.match) ? Math.round(result.match) : result.match;
  const matchTooltip = result.neededGroups
    ? `Matched ${result.matchedGroups} of ${result.neededGroups} search terms`
    : "No active filters";
  const matchBadge = makeBadge(`${matchValue}% Match`, { tooltip: matchTooltip, className: "match" });
  if (result.tier) matchBadge.dataset.matchTier = result.tier;

  const proteinSources = (product.protein_sources || []).map((item) => item.replace(/_/g, " ")).join(", ");
  const proteinBadge = makeBadge("Protein", { tooltip: proteinSources || undefined });
  const grainsBadge = makeBadge(`Grains: ${yesNoLabel(product.contains_grain)}`);

  badges.append(matchBadge, proteinBadge, grainsBadge);
  content.append(img, badges);

  const button = create("button", { className: "pf-ingredients-btn", textContent: "Ingredients" });
  button.addEventListener("click", () => openIngredientsPopup(product));

  card.append(header, content, button);
  return card;
};

/* ========= render main ========= */
const renderMeta = (total, shown, labelIncludes, labelExcludes) => {
  const countEl = $("#countLabel");
  if (countEl) countEl.textContent = total === 0 && shown === 0 ? "" : `${shown}/${total} shown`;

  const filtersEl = $("#filtersLabel");
  if (!filtersEl) return;
  const includes = [...(labelIncludes || [])].join(", ");
  const excludes = [...(labelExcludes || [])].join(", ");
  filtersEl.textContent = includes || excludes ? `includes: [${includes}]  excludes: [${excludes}]` : "";
};

const render = (products, includeGroups, excludes, labelIncludes, labelExcludes) => {
  const container = $("#results");
  container.innerHTML = "";

  const hasQuery = includeGroups.length || excludes.size;
  if (!hasQuery) {
    container.innerHTML = '<p class="muted instructions">Start typing to see matches.</p>';
    renderMeta(0, 0, labelIncludes, labelExcludes);
    return;
  }

  const matches = products
    .map((product) => ({ product, result: computeMatch(product, includeGroups, excludes) }))
    .filter(({ result }) => result.show !== false)
    .sort(
      (a, b) =>
        b.result.sortScore - a.result.sortScore ||
        a.product.name.localeCompare(b.product.name)
    );

  const limited = matches.slice(0, 6);

  renderMeta(matches.length, limited.length, labelIncludes, labelExcludes);

  if (!limited.length) {
    container.innerHTML = '<p class="muted">No matches found.</p>';
    return;
  }

  limited.forEach(({ product, result }) => container.append(makeCard(product, result)));
};

/* ========= init ========= */
(async function init() {
  const results = $("#results");
  results?.setAttribute("aria-busy", "true");

  let products = [];
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load ${DATA_URL}: ${response.status}`);
    products = await response.json();
  } catch (error) {
    console.error(error);
    results.innerHTML = `<p class="muted">Could not load data. Check <code>${DATA_URL}</code>.</p>`;
    return;
  } finally {
    results?.setAttribute("aria-busy", "false");
  }

  const input = $("#query");
  const fetchBtn = $("#fetchBtn");
  const clearBtn = $("#clearBtn");

  const runSearch = () => {
    const { includeGroups, excludes, labelIncludes, labelExcludes } = parseQuery(input.value);
    render(products, includeGroups, excludes, labelIncludes, labelExcludes);
  };

  render(products, [], new Set(), new Set(), new Set());

  let debounceTimer;
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 150);
  });
  fetchBtn.addEventListener("click", runSearch);
  clearBtn.addEventListener("click", () => {
    input.value = "";
    render(products, [], new Set(), new Set(), new Set());
  });
})();

