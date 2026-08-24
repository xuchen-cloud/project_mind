const rules = [
  { name: "no-transition-all", pattern: /\btransition-all\b|transition\s*:\s*all\b/gu },
  {
    name: "no-layout-transition",
    pattern: /transition(?:-property)?\s*:[^;}]*(?:width|height|max-height|margin|padding|top|left)\b|transition-\[[^\]]*(?:width|height|max-height|margin|padding|top|left)[^\]]*\]/gu,
  },
  { name: "no-scale-zero", pattern: /scale\(0(?:\.0+)?\)|scale-\[0\]/gu },
  { name: "no-ease-in", pattern: /\bease-in(?!-out)\b/gu },
  { name: "no-bare-easing", pattern: /(?:transition|animation)[^;}]*(?:^|\s)ease(?=\s*[,;}])/gmu },
];

function lineNumber(content, index) {
  return content.slice(0, index).split("\n").length;
}

function snippetAt(content, index) {
  const start = content.lastIndexOf("\n", index) + 1;
  const end = content.indexOf("\n", index);
  return content.slice(start, end < 0 ? content.length : end).trim();
}

function closingBraceIndex(content, openIndex) {
  let depth = 0;
  let quote = null;
  let inComment = false;

  for (let index = openIndex; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (inComment) {
      if (character === "*" && next === "/") {
        inComment = false;
        index += 1;
      }
      continue;
    }
    if (!quote && character === "/" && next === "*") {
      inComment = true;
      index += 1;
      continue;
    }
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return content.length;
}

function atRuleRanges(content, pattern) {
  const ranges = [];
  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    const open = content.indexOf("{", start + match[0].length);
    if (open < 0) continue;
    ranges.push({ start, open, end: closingBraceIndex(content, open), name: match[1] });
  }
  return ranges;
}

function includesIndex(ranges, index) {
  return ranges.some((range) => index > range.open && index < range.end);
}

function cssRules(content) {
  const rules = [];
  for (const match of content.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const selector = match[1].trim();
    if (!selector || selector.startsWith("@") || /^(?:from|to|\d+(?:\.\d+)?%)$/u.test(selector)) {
      continue;
    }
    const index = match.index ?? 0;
    rules.push({ selector, body: match[2], index, end: index + match[0].length });
  }
  return rules;
}

function selectorSubject(selector) {
  const compound = selector.trim().split(/\s+|>|\+|~/u).filter(Boolean).at(-1) ?? selector.trim();
  const names = Array.from(compound.matchAll(/[.#][-_a-zA-Z0-9]+/gu), (match) => match[0]);
  if (names.length > 0) return names.join("");
  const attributes = Array.from(compound.matchAll(/\[[^\]]+\]/gu), (match) => match[0]);
  if (attributes.length > 0) return attributes.join("");
  return compound.replace(/:{1,2}[-_a-zA-Z0-9()]+/gu, "");
}

function splitSelectors(selector) {
  return selector.split(",").map((item) => item.trim()).filter(Boolean);
}

function quotedStrings(content) {
  const strings = [];
  for (let index = 0; index < content.length; index += 1) {
    const quote = content[index];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;

    const start = index;
    let value = "";
    for (index += 1; index < content.length; index += 1) {
      const character = content[index];
      if (character === "\\") {
        value += character;
        if (index + 1 < content.length) value += content[index += 1];
        continue;
      }
      if (character === quote) break;
      value += character;
    }
    strings.push({ index: start, value });
  }
  return strings;
}

function declaresTransformMotion(body, transformKeyframes = new Set()) {
  if (/transition(?:-property)?\s*:[^;}]*\b(?:transform|translate|scale)\b/u.test(body)) {
    return true;
  }
  return Array.from(transformKeyframes).some((name) =>
    new RegExp(`animation(?:-name)?\\s*:[^;}]*\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u")
      .test(body),
  );
}

function disablesTransformMotion(body) {
  return /(?:transform|translate|scale)\s*:\s*(?:none|initial|unset)\b/u.test(body) ||
    /transition(?:-property)?\s*:\s*none\b/u.test(body) ||
    /animation(?:-name)?\s*:\s*none\b/u.test(body);
}

const continuousSpinnerSelectors = new Set([
  ".spin",
  ".animate-spin",
  ".rich-editor__tool-spinner",
]);

function isAllowedContinuousSpinner(rules, index) {
  const rule = rules.find((candidate) => index >= candidate.index && index <= candidate.end);
  if (!rule || !/animation\s*:\s*spin\b[^;}]*\binfinite\b/u.test(rule.body)) return false;
  return splitSelectors(rule.selector).every((selector) =>
    continuousSpinnerSelectors.has(selectorSubject(selector)),
  );
}

export function collectMotionViolations(file, content) {
  const violations = [];
  const add = (name, index, snippet = snippetAt(content, index)) => {
    violations.push({ file, line: lineNumber(content, index), rule: name, snippet });
  };

  for (const rule of rules) {
    for (const match of content.matchAll(new RegExp(rule.pattern.source, rule.pattern.flags))) {
      add(rule.name, match.index ?? 0);
    }
  }

  if (file.endsWith(".css")) {
    const parsedRules = cssRules(content);
    for (const match of content.matchAll(/\b(\d+)ms\b/gu)) {
      const duration = Number(match[1]);
      const line = snippetAt(content, match.index ?? 0);
      const isTokenDefinition = /--duration-(?:fast|standard|deliberate)\s*:/u.test(line);
      const isReducedMotionTechnicalValue = duration === 1 && /transition-duration/u.test(line);
      if (!isTokenDefinition && !isReducedMotionTechnicalValue) {
        add("no-raw-motion-duration", match.index ?? 0, line);
      }
      if (duration > 300 && !isAllowedContinuousSpinner(parsedRules, match.index ?? 0)) {
        add("no-long-ui-motion", match.index ?? 0, line);
      }
    }

    for (const match of content.matchAll(/\b(\d+(?:\.\d+)?)s\b/gu)) {
      const line = snippetAt(content, match.index ?? 0);
      if (Number(match[1]) === 0) continue;
      if (isAllowedContinuousSpinner(parsedRules, match.index ?? 0)) continue;
      add("no-raw-motion-duration", match.index ?? 0, line);
      if (Number(match[1]) * 1000 > 300) add("no-long-ui-motion", match.index ?? 0, line);
    }

    const reducedRanges = atRuleRanges(
      content,
      /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/gu,
    );
    const keyframeRanges = atRuleRanges(
      content,
      /@(?:-webkit-)?keyframes\s+([-_a-zA-Z0-9]+)/gu,
    );
    const transformKeyframes = new Set(
      keyframeRanges
        .filter((range) =>
          /(?:transform|translate|scale)\s*:\s*(?!none\b)[^;}]+/u.test(
            content.slice(range.open + 1, range.end),
          ),
        )
        .map((range) => range.name),
    );
    const reducedContracts = new Set(
      parsedRules
        .filter((rule) => includesIndex(reducedRanges, rule.index) && disablesTransformMotion(rule.body))
        .flatMap((rule) => splitSelectors(rule.selector).map(selectorSubject)),
    );
    for (const rule of parsedRules) {
      if (
        includesIndex(reducedRanges, rule.index) ||
        includesIndex(keyframeRanges, rule.index) ||
        !declaresTransformMotion(rule.body, transformKeyframes)
      ) {
        continue;
      }
      for (const selector of splitSelectors(rule.selector)) {
        if (!reducedContracts.has(selectorSubject(selector))) {
          add("requires-reduced-motion", rule.index, selector);
        }
      }
    }
  } else {
    for (const match of content.matchAll(/duration-\[(\d+)ms\]/gu)) {
      add("no-raw-motion-duration", match.index ?? 0);
    }
    for (const match of content.matchAll(/(?:transitionDuration|animationDuration)\s*:\s*["'`]\d+(?:\.\d+)?(?:ms|s)["'`]/gu)) {
      add("no-raw-motion-duration", match.index ?? 0);
    }

    for (const match of quotedStrings(content)) {
      const value = match.value;
      const hasTransformTransition =
        /(?:^|\s)transition-transform(?:\s|$)/u.test(value) ||
        /transition-\[[^\]]*\b(?:transform|translate|scale)\b[^\]]*\]/u.test(value);
      const hasReducedMotionContract =
        /motion-reduce:(?:transform-none|transition-none|translate-[xy]-0|scale-100|rotate-0)\b/u
          .test(value);
      if (hasTransformTransition && !hasReducedMotionContract) {
        add("requires-reduced-motion", match.index, value);
      }

      const hasAnimation = /(?:^|\s)animate-(?!none(?:\s|$))\S+/u.test(value);
      if (hasAnimation && !/(?:^|\s)motion-reduce:animate-none(?:\s|$)/u.test(value)) {
        add("requires-reduced-motion", match.index, value);
      }
    }

    for (const match of content.matchAll(/animate-\[[^\]]*_(\d+(?:\.\d+)?)(ms|s)(?:_|\])/gu)) {
      const duration = Number(match[1]) * (match[2] === "s" ? 1000 : 1);
      add("no-raw-motion-duration", match.index ?? 0);
      if (duration > 300) add("no-long-ui-motion", match.index ?? 0);
    }
  }

  return violations;
}
