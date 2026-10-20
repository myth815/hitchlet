/** Authoritative credential scope ceiling for each role; configuration edits may only narrow existing credentials to this set. */
export function roleScopes(
  role: "viewer" | "consumer" | "operator" | "admin",
): string[] {
  if (role === "viewer") return ["tickets:read", "images:read", "events:read"];
  if (role === "operator" || role === "admin")
    return [
      "tickets:read",
      "tickets:write",
      "tickets:revoke",
      "images:read",
      "events:read",
    ];
  return ["tickets:read", "tickets:write", "images:read", "events:read"];
}
