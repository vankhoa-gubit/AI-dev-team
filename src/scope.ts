interface ScopeDescriptor {
  kind: "exact" | "tree";
  value: string;
  original: string;
}

function normalizeScope(pattern: string): ScopeDescriptor {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const wildcard = normalized.search(/[?*]/);
  if (wildcard < 0) {
    return { kind: "exact", value: normalized, original: pattern };
  }
  const slash = normalized.lastIndexOf("/", wildcard);
  const root = slash < 0 ? "" : normalized.slice(0, slash);
  if (!root) {
    throw new Error(`Delegation scope is too broad to prove disjoint: ${pattern}`);
  }
  return { kind: "tree", value: root, original: pattern };
}

function scopesOverlap(left: ScopeDescriptor, right: ScopeDescriptor): boolean {
  if (left.kind === "exact" && right.kind === "exact") {
    return left.value === right.value;
  }
  if (left.kind === "tree" && right.kind === "tree") {
    return left.value === right.value
      || left.value.startsWith(`${right.value}/`)
      || right.value.startsWith(`${left.value}/`);
  }
  const tree = left.kind === "tree" ? left : right;
  const exact = left.kind === "exact" ? left : right;
  return exact.value === tree.value || exact.value.startsWith(`${tree.value}/`);
}

export function findOverlappingScope(
  leftPatterns: string[],
  rightPatterns: string[],
): { left: string; right: string } | undefined {
  for (const leftPattern of leftPatterns) {
    const left = normalizeScope(leftPattern);
    for (const rightPattern of rightPatterns) {
      const right = normalizeScope(rightPattern);
      if (scopesOverlap(left, right)) {
        return { left: left.original, right: right.original };
      }
    }
  }
  return undefined;
}
