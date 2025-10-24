"use strict";

/* ========= config ========= */
const DATA_URL = "data/products.json";

/* ========= tiny DOM helpers ========= */
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
  grain_free: ["grain_free", "no_grain", "no_grains", "grainfree"],
  no_grain: ["grain_free", "no_grains", "grainfree"],
  no_grains: ["grain_free", "no_grain", "grainfree"],
  without_grain: ["grain_free", "no_grain", "no_grains", "grainfree"],
  without_grains: ["grain_free", "no_grain", "no_grains", "grainfree"],
  with_grain: ["contains_grain", "grain", "grains", "with_grains"],
  with_grains: ["contains_grain", "grain", "grains", "with_grain"],
  grains: ["contains_grain", "grain"],
  grain: ["contains_grain", "grains", "with_grains", "with_grain"],
  contains_grain: ["contains_grain"],
  protein: ["has_protein", "protein"],
  no_protein: ["no_protein"],
  taste: ["taste", "taste_of_the_wild", "totw"],
  totw: ["taste_of_the_wild"],
};

const GRAIN_WITH_TOKENS = new Set([
  "contains_grain",
  "grain",
  "grains",
  "with_grain",
  "with_grains",
]);

const GRAIN_FREE_TOKENS = new Set([
  "grain_free",
  "grainfree",
  "no_grain",
  "no_grains",
  "without_grain",
  "without_grains",
]);

const expandSynonyms = (tok) => {
  const base = normalizeToken(tok);
  const variants = new Set([base]);
  (SYNONYMS[base] || []).forEach((value) => variants.add(value));
  simplePluralVariants(base).forEach((value) => variants.add(value));
  return variants;
};

const PHRASE_SYNONYM_OVERRIDES = new Set([
  "grain_free",
  "no_grain",
  "no_grains",
  "with_grain",
  "with_grains",
  "without_grain",
  "without_grains",
]);

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

  for (let index = 0; index < parts.length; ) {
    const raw = parts[index];
    if (!raw) {
      index += 1;
      continue;
    }

    const isExclude = raw.startsWith("-");
    const baseRaw = isExclude ? raw.slice(1) : raw;
    const base = normalizeToken(baseRaw);
    if (!base) {
      index += 1;
      continue;
    }

    const group = new Set();
    let labelToken = base;
    let skipNext = false;

    const nextRaw = parts[index + 1];
    let phraseToken = "";
    if (nextRaw && !nextRaw.startsWith("-")) {
      const next = normalizeToken(nextRaw);
      if (next) {
        phraseToken = normalizeToken(`${base}_${next}`);
        if (phraseToken && PHRASE_SYNONYM_OVERRIDES.has(phraseToken)) {
          skipNext = true;
          labelToken = phraseToken;
          expandSynonyms(phraseToken).forEach((token) => group.add(token));
        }
      }
    }

    if (!skipNext) {
      expandSynonyms(base).forEach((token) => group.add(token));
      if (phraseToken) {
        group.add(phraseToken);
        simplePluralVariants(phraseToken).forEach((value) => group.add(value));
      }
    }

    if (!group.size) {
      index += skipNext ? 2 : 1;
      continue;
    }

    const labelTarget = isExclude ? labelExcludes : labelIncludes;
    if (labelToken) labelTarget.add(labelToken);

    if (isExclude) {
      group.forEach((token) => excludes.add(token));
    } else {
      includeGroups.push(group);
    }

    index += skipNext ? 2 : 1;
  }

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

const orderedIngredientTokens = (product) => {
  const ordered = [];

  String(product.ingredients_list || "")
    .split(/[;,\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const normalized = normalizeToken(item);
      if (normalized) ordered.push(normalized);
    });

  (product.protein_sources || []).forEach((source) => {
    const normalized = normalizeToken(source);
    if (normalized) ordered.push(normalized);
  });

  return ordered;
};

const ingredientTokenMatches = (token, ingredient) => {
  if (!token || !ingredient) return false;
  if (ingredient === token) return true;
  if (ingredient.startsWith(`${token}_`)) return true;
  if (token.startsWith(`${ingredient}_`)) return true;
  if (!token.includes("_")) {
    const parts = ingredient.split("_");
    if (parts.includes(token)) return true;
  }
  return false;
};

const evaluateIngredientGroupScore = (tokens, orderedIngredients) => {
  if (!orderedIngredients.length) {
    return { ingredientMatched: false, ingredientScore: 0, ingredientIndex: null };
  }

  let bestIndex = null;

  orderedIngredients.forEach((ingredient, index) => {
    if (bestIndex !== null && index >= bestIndex) return;
    for (const token of tokens) {
      if (ingredientTokenMatches(token, ingredient)) {
        bestIndex = index;
        return;
      }
    }
  });

  if (bestIndex === null)
    return { ingredientMatched: false, ingredientScore: 0, ingredientIndex: null };

  const ingredientScore = 1 - bestIndex / orderedIngredients.length;
  return { ingredientMatched: true, ingredientScore, ingredientIndex: bestIndex };
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
  const orderedIngredients = orderedIngredientTokens(product);

  for (const ex of excludes) {
    if (hasTokenExclude(tokens, ex)) {
      return { match: 0, sortScore: 0, matchedGroups: 0, neededGroups: includeGroups.length, show: false };
    }
  }

  const neededGroups = includeGroups.length;
  const groupEvaluations = includeGroups.map((group) => {
    const normalizedGroupTokens = [...group].map(normalizeToken).filter(Boolean);
    const requirement = normalizedGroupTokens.some((token) => GRAIN_WITH_TOKENS.has(token))
      ? "with"
      : normalizedGroupTokens.some((token) => GRAIN_FREE_TOKENS.has(token))
      ? "without"
      : null;
    const matched = normalizedGroupTokens.some((token) => hasToken(tokens, token));
    const ingredientData = evaluateIngredientGroupScore(normalizedGroupTokens, orderedIngredients);
    return { matched, requirement, ...ingredientData };
  });

  const matchedGroups = groupEvaluations.filter((group) => group.matched).length;

  if (neededGroups > 0 && matchedGroups === 0)
    return { match: 0, sortScore: 0, matchedGroups, neededGroups, show: false };

  const requiresGrain = groupEvaluations.some((group) => group.requirement === "with");
  const requiresGrainFree = groupEvaluations.some((group) => group.requirement === "without");

  if (
    (requiresGrain && !groupEvaluations.some((group) => group.requirement === "with" && group.matched)) ||
    (requiresGrainFree &&
      !groupEvaluations.some((group) => group.requirement === "without" && group.matched))
  )
    return { match: 0, sortScore: 0, matchedGroups, neededGroups, show: false };

  const ingredientMatchedGroups = groupEvaluations.filter((group) => group.ingredientMatched);

  const totalScore = groupEvaluations.reduce((score, group) => {
    if (!group.matched) return score;
    if (group.ingredientMatched) return score + group.ingredientScore;
    return score + 1;
  }, 0);

  const match = neededGroups === 0 ? 0 : Math.round((totalScore / neededGroups) * 100);

  const frequencyScore = includeGroups.reduce((score, group) => {
    let groupCount = 0;
    group.forEach((token) => {
      groupCount = Math.max(groupCount, countTokenMatches(frequencyTokens, token));
    });
    return score + groupCount;
  }, 0);

  const ingredientRankBoost = ingredientMatchedGroups.reduce((boost, group) => {
    if (group.ingredientIndex === null) return boost;
    return boost + (orderedIngredients.length - group.ingredientIndex);
  }, 0);

  const sortScore = match * 1000 + ingredientRankBoost * 10 + frequencyScore;

  return { match, sortScore, matchedGroups, neededGroups, show: true };
};


/* ========= helpers ========= */
const yesNoLabel = (value) => (value === true ? "Yes" : value === false ? "No" : "—");

/* ========= popup ========= */
const removeExistingPopups = () =>
  document
    .querySelectorAll(
      ".ingredients-popup, .match-info-popup, .protein-info-popup, .grains-info-popup"
    )
    .forEach((el) => el.remove());

const openIngredientsPopup = (product) => {
  removeExistingPopups();

  const ingredientsText = (product.ingredients_list || "No ingredients listed.")
    .split(/[;,\n]+/)
    .map((value) => value.trim().replace(/_/g, " "))
    .filter(Boolean)
    .join(", ");

  const overlay = create("div", { className: "compare-popup ingredients-popup" });
  overlay.innerHTML = `
    <div class="popup-content">
      <button class="popup-close-icon" type="button" aria-label="Close">&times;</button>
      <h2>${product.name}</h2>
      <p class="brand">${product.brand}</p>
      <div class="ingredients-body">${ingredientsText}</div>
    </div>
  `;
  document.body.append(overlay);
  overlay.querySelector(".popup-close-icon")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (event) => event.target === overlay && overlay.remove());
};

const openMatchInfoPopup = () => {
  removeExistingPopups();

  const overlay = create("div", { className: "compare-popup match-info-popup" });
  overlay.innerHTML = `
    <div class="popup-content">
      <button class="popup-close-icon" type="button" aria-label="Close">&times;</button>
      <h2>Match %</h2>
      <div class="match-info-body">
        <section>
          <h3>Quick summary</h3>
          <p>A fit score based on your include / exclude terms vs. this product’s ingredient list.</p>
        </section>
        <section>
          <h3>What it means</h3>
          <ul>
            <li><strong>&ge;90%</strong>: strong fit</li>
            <li><strong>70–89%</strong>: partial fit</li>
            <li><strong>&lt;70%</strong>: weak fit</li>
          </ul>
        </section>
        <section>
          <h3>How it’s calculated (plain English)</h3>
          <ul>
            <li>+ points for every included term found</li>
            <li>– points for every excluded term present</li>
            <li>Normalized to a % (ingredients only; no price or quality judgment)</li>
          </ul>
        </section>
        <section>
          <h3>Learn more</h3>
          <a class="learn-more-link" href="https://wsava.org/wp-content/uploads/2021/04/Selecting-a-pet-food-for-your-pet-updated-2021_WSAVA-Global-Nutrition-Toolkit.pdf" target="_blank" rel="noopener">WSAVA — Selecting a Pet Food (PDF)</a>
        </section>
      </div>
    </div>
  `;

  document.body.append(overlay);
  overlay.querySelector(".popup-close-icon")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (event) => event.target === overlay && overlay.remove());
};

const openProteinInfoPopup = () => {
  removeExistingPopups();

  const overlay = create("div", { className: "compare-popup protein-info-popup" });
  overlay.innerHTML = `
    <div class="popup-content">
      <button class="popup-close-icon" type="button" aria-label="Close">&times;</button>
      <h2>Protein %</h2>
      <div class="protein-info-body">
        <section>
          <h3>Quick summary</h3>
          <p><strong>Label crude protein (as-fed)</strong>: shows how much, not where it comes from.</p>
        </section>
        <section>
          <h3>How to read it</h3>
          <ul>
            <li>Typical dry kibble: ~24–32%</li>
            <li>Higher-protein kibble: ~34–40%</li>
            <li>Fresh/wet foods read lower as-fed (more water)</li>
          </ul>
        </section>
        <section>
          <h3>Allergies &amp; protein</h3>
          <p>Dogs usually react to specific proteins (e.g., chicken, beef, dairy, egg)—not to “protein %.” If you suspect allergy, discuss a novel or hydrolyzed protein elimination diet with your vet.</p>
        </section>
        <section>
          <h3>Learn more</h3>
          <ul class="protein-info-links">
            <li><a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC4710035/" target="_blank" rel="noopener">BMC Vet Research — Common food allergen sources in dogs and cats</a></li>
            <li><a href="https://pubmed.ncbi.nlm.nih.gov/28854915/" target="_blank" rel="noopener">PubMed — Diagnosing adverse food reactions: elimination diet with provocation is the gold standard</a></li>
          </ul>
        </section>
      </div>
    </div>
  `;

  document.body.append(overlay);
  overlay.querySelector(".popup-close-icon")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (event) => event.target === overlay && overlay.remove());
};

const openGrainsInfoPopup = () => {
  removeExistingPopups();

  const overlay = create("div", { className: "compare-popup grains-info-popup" });
  overlay.innerHTML = `
    <div class="popup-content">
      <button class="popup-close-icon" type="button" aria-label="Close">&times;</button>
      <h2>Grains</h2>
      <div class="grains-info-body">
        <section>
          <h3>Quick summary</h3>
          <p>Flags whether named grains appear in the ingredient list (e.g., wheat, corn, rice, barley, oats, rye).</p>
        </section>
        <section>
          <h3>Why it matters</h3>
          <p>Many dogs do fine with grains; a minority have grain sensitivities. “Grain-free” often swaps grains for <strong>legumes or potatoes</strong>&mdash;read labels closely.</p>
        </section>
        <section>
          <h3>Learn more</h3>
          <ul class="grains-info-links">
            <li><a href="https://wsava.org/global-guidelines/global-nutrition-guidelines/" target="_blank" rel="noopener">WSAVA — Global Nutrition Guidelines</a></li>
            <li><a href="https://www.fda.gov/animal-veterinary/outbreaks-and-advisories/fda-investigation-potential-link-between-certain-diets-and-canine-dilated-cardiomyopathy" target="_blank" rel="noopener">FDA CVM — Q&amp;A on diet-associated DCM (ongoing)</a></li>
          </ul>
        </section>
      </div>
    </div>
  `;

  document.body.append(overlay);
  overlay.querySelector(".popup-close-icon")?.addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", (event) => event.target === overlay && overlay.remove());
};

/* ========= render cards ========= */
const makeBadge = (text, { tooltip, className = "", onClick } = {}) => {
  const tag = onClick ? "button" : "div";
  const options = {
    className: ["compare-badge", className].filter(Boolean).join(" "),
    textContent: text,
  };
  if (onClick) options.type = "button";
  const badge = create(tag, options);
  if (tooltip) {
    badge.classList.add("compare-has-badge-tooltip");
    badge.dataset.badgeTooltip = tooltip;
  }
  if (typeof onClick === "function") {
    badge.classList.add("is-clickable");
    badge.addEventListener("click", onClick);
  }
  return badge;
};

const makeCard = (product, result, onRemove) => {
  const card = create("article", { className: "compare-card" });

  const removeButton = create("button", {
    className: "compare-card__remove",
    type: "button",
    textContent: "×",
    ariaLabel: "Remove product",
  });
  removeButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof onRemove === "function") onRemove(product);
  });

  card.append(removeButton);

  const header = create("div", { className: "compare-card__header" });
  const brandWrapper = create("div", { className: "compare-card__brand" });
  const brandLink = create("a", {
    href: product.brand_url || "#",
    target: "_blank",
    rel: "noopener",
    textContent: product.brand || "—",
  });
  brandWrapper.append(brandLink);
  const title = create("div", { className: "compare-card__title" });
  const shortName = product.name.split(" ").slice(0, 3).join(" ");
  title.textContent = shortName;
  title.classList.add("compare-has-title-tooltip");
  title.dataset.titleTooltip = product.name;
  header.append(brandWrapper, title);

  const content = create("div", { className: "compare-card__content" });
  const destination = product.product_url || product.brand_url || "";
  const imageLink = create("a", {
    className: "compare-card__image-link",
    href: destination || "#",
  });
  if (destination) {
    imageLink.target = "_blank";
    imageLink.rel = "noopener";
  }
  const img = create("img", { src: product.image || "", alt: `${product.name} image` });
  imageLink.append(img);
  const badges = create("div", { className: "compare-card__badges" });

  const matchValue = Number.isFinite(result.match) ? Math.round(result.match) : result.match;
  const matchTooltip = "Compatibility based on include/exclude filters";
  const matchBadge = makeBadge(`${matchValue}% Match`, {
    tooltip: matchTooltip,
    className: "compare-badge--match",
    onClick: openMatchInfoPopup,
  });
  if (result.tier) matchBadge.dataset.matchTier = result.tier;

  const proteinTooltip = "Protein analysis (crude protein) reported by the manufacturer.";
  const proteinBadge = makeBadge("Protein %", {
    tooltip: proteinTooltip,
    className: "compare-badge--protein",
    onClick: openProteinInfoPopup,
  });
  const grainsTooltip = "Grain content as reported by the manufacturer.";
  const grainsLabel = yesNoLabel(product.contains_grain);
  const grainsBadge = makeBadge(`Grains: ${grainsLabel}`, {
    tooltip: grainsLabel === "Yes" ? grainsTooltip : undefined,
    onClick: openGrainsInfoPopup,
  });

  badges.append(matchBadge, proteinBadge, grainsBadge);
  content.append(imageLink, badges);

  const button = create("button", { className: "compare-ingredients-btn", textContent: "Ingredients" });
  button.addEventListener("click", () => openIngredientsPopup(product));

  card.append(header, content, button);
  return card;
};

/* ========= render main ========= */
const renderMeta = (root, total, shown, labelIncludes, labelExcludes) => {
  const countEl = root.querySelector("[data-compare-count]");
  if (countEl) countEl.textContent = total === 0 && shown === 0 ? "" : `${shown}/${total} shown`;

  const filtersEl = root.querySelector("[data-compare-filters]");
  if (!filtersEl) return;
  const includes = [...(labelIncludes || [])].join(", ");
  const excludesText = [...(labelExcludes || [])].join(", ");
  filtersEl.textContent = includes || excludesText ? `includes: [${includes}]  excludes: [${excludesText}]` : "";
};

const render = (
  root,
  products,
  includeGroups,
  excludes,
  labelIncludes,
  labelExcludes,
  { removedProductIds = new Set(), onRemove } = {}
) => {
  const container = root.querySelector("[data-compare-results]");
  if (!container) return;
  container.innerHTML = "";

  const hasQuery = includeGroups.length || excludes.size;
  if (!hasQuery) {
    container.innerHTML = '<p class="compare-muted compare-instructions">Start typing to see matches.</p>';
    renderMeta(root, 0, 0, labelIncludes, labelExcludes);
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

  const visibleMatches = matches.filter(({ product }) => !removedProductIds.has(product.id));

  const limited = visibleMatches.slice(0, 6);

  renderMeta(root, visibleMatches.length, limited.length, labelIncludes, labelExcludes);

  if (!limited.length) {
    container.innerHTML = '<p class="compare-muted">No matches found.</p>';
    return;
  }

  limited.forEach(({ product, result }) =>
    container.append(makeCard(product, result, onRemove))
  );
};

/* ========= init ========= */
(async function init() {
  const root = document.querySelector("[data-compare-app-root]");
  if (!root) return;

  const results = root.querySelector("[data-compare-results]");
  results?.setAttribute("aria-busy", "true");

  let products = [];
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load ${DATA_URL}: ${response.status}`);
    products = await response.json();
  } catch (error) {
    console.error(error);
    if (results)
      results.innerHTML = `<p class="compare-muted">Could not load data. Check <code>${DATA_URL}</code>.</p>`;
    return;
  } finally {
    results?.setAttribute("aria-busy", "false");
  }

  const input = root.querySelector("[data-compare-query]");
  const fetchBtn = root.querySelector("[data-compare-fetch]");
  const clearBtn = root.querySelector("[data-compare-clear]");

  const removedProductIds = new Set();
  let currentState = {
    includeGroups: [],
    excludes: new Set(),
    labelIncludes: new Set(),
    labelExcludes: new Set(),
  };

  function renderWithCurrentState() {
    render(
      root,
      products,
      currentState.includeGroups,
      currentState.excludes,
      currentState.labelIncludes,
      currentState.labelExcludes,
      {
        removedProductIds,
        onRemove: handleRemoveProduct,
      }
    );
  }

  function handleRemoveProduct(product) {
    if (!product || !product.id) return;
    removedProductIds.add(product.id);
    renderWithCurrentState();
  }

  const runSearch = () => {
    const value = input?.value ?? "";
    const { includeGroups, excludes, labelIncludes, labelExcludes } = parseQuery(value);
    currentState = { includeGroups, excludes, labelIncludes, labelExcludes };
    renderWithCurrentState();
  };

  renderWithCurrentState();

  let debounceTimer;
  input?.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 150);
  });
  fetchBtn?.addEventListener("click", runSearch);
  clearBtn?.addEventListener("click", () => {
    if (input) input.value = "";
    removedProductIds.clear();
    currentState = {
      includeGroups: [],
      excludes: new Set(),
      labelIncludes: new Set(),
      labelExcludes: new Set(),
    };
    renderWithCurrentState();
  });
})();

