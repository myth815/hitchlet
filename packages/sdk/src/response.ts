/**
 * Parse a server response using the contracts schema while tolerating additive
 * fields on strict contract objects. Request validation must continue to call
 * the schema directly.
 *
 * We only remove keys named by Zod's `unrecognized_keys` issues, then rerun
 * the authoritative schema. All required fields, values, and known nested
 * shapes therefore remain validated by the contracts package.
 */
export function parseResponse<T>(
  schema: { parse(value: unknown): T; safeParse(value: unknown): unknown },
  value: unknown,
): T {
  let candidate: unknown = structuredClone(value);

  for (;;) {
    const result = schema.safeParse(candidate) as {
      success?: boolean;
      data?: T;
      error?: { issues?: readonly unknown[] };
    };
    if (result.success) return result.data as T;

    type Removal = { path: readonly PropertyKey[]; keys: readonly string[] };
    type Issue = {
      code?: unknown;
      path?: unknown;
      keys?: unknown;
      errors?: unknown;
    };
    const atPath = (
      issue: Issue,
      prefix: readonly PropertyKey[],
    ): readonly PropertyKey[] =>
      Array.isArray(issue.path)
        ? [...prefix, ...(issue.path as PropertyKey[])]
        : prefix;

    // An ordinary union reports errors for every alternative. Only a branch
    // whose issues can all be explained by extensions is a candidate match;
    // pruning keys from the other branches can erase valid fields.
    const collectBranch = (
      issues: readonly unknown[],
      prefix: readonly PropertyKey[],
    ): Removal[] | null => {
      const removals: Removal[] = [];
      for (const raw of issues) {
        if (!raw || typeof raw !== "object") return null;
        const issue = raw as Issue;
        const path = atPath(issue, prefix);
        if (
          issue.code === "unrecognized_keys" &&
          Array.isArray(issue.keys) &&
          issue.keys.every((key) => typeof key === "string")
        ) {
          removals.push({ path, keys: issue.keys as string[] });
          continue;
        }
        if (issue.code !== "invalid_union" || !Array.isArray(issue.errors))
          return null;
        const compatible = (issue.errors as unknown[])
          .filter(Array.isArray)
          .map((branch) => collectBranch(branch, path))
          .find((candidate): candidate is Removal[] => candidate !== null);
        if (!compatible) return null;
        removals.push(...compatible);
      }
      return removals;
    };

    const collect = (
      issues: readonly unknown[],
      prefix: readonly PropertyKey[] = [],
    ): Removal[] => {
      const removals: Removal[] = [];
      for (const raw of issues) {
        if (!raw || typeof raw !== "object") continue;
        const issue = raw as Issue;
        const path = atPath(issue, prefix);
        if (
          issue.code === "unrecognized_keys" &&
          Array.isArray(issue.keys) &&
          issue.keys.every((key) => typeof key === "string")
        ) {
          removals.push({ path, keys: issue.keys as string[] });
        } else if (
          issue.code === "invalid_union" &&
          Array.isArray(issue.errors)
        ) {
          const compatible = (issue.errors as unknown[])
            .filter(Array.isArray)
            .map((branch) => collectBranch(branch, path))
            .find((candidate): candidate is Removal[] => candidate !== null);
          if (compatible) removals.push(...compatible);
        }
      }
      return removals;
    };
    const removals = collect(result.error?.issues ?? []);
    if (removals.length === 0) return schema.parse(candidate);

    let removed = false;
    for (const { path, keys } of removals) {
      let parent: unknown = candidate;
      for (const segment of path) {
        if (parent === null || typeof parent !== "object") break;
        parent = (parent as Record<PropertyKey, unknown>)[segment];
      }
      if (
        parent === null ||
        typeof parent !== "object" ||
        Array.isArray(parent)
      )
        continue;
      for (const key of keys) {
        if (Object.hasOwn(parent, key)) {
          delete (parent as Record<string, unknown>)[key];
          removed = true;
        }
      }
    }
    if (!removed) return schema.parse(candidate);
  }
}
