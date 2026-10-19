import { describe, expect, it } from "vitest";
import { dockerImageReferencePath } from "../src/domain/docker-image-reference.js";

describe("Portainer CE 2.45 Docker image proxy path regression", () => {
  it("keeps repository slashes literal for both image inspect and distribution routes", () => {
    const ref = `docker.io/library/node@sha256:${"a".repeat(64)}`;
    const encoded = dockerImageReferencePath(ref);
    for (const kind of ["images", "distribution"]) {
      const url = new URL(
        `/api/endpoints/1/docker/${kind}/${encoded}/json`,
        "https://portainer.test",
      );
      expect(url.pathname).toBe(
        `/api/endpoints/1/docker/${kind}/docker.io/library/node%40sha256%3A${"a".repeat(64)}/json`,
      );
      expect(url.pathname).not.toContain("%2F");
      expect(decodeURIComponent(url.pathname)).toContain(ref);
    }
    expect(
      dockerImageReferencePath(
        `registry.example:5000/team/node:v1@sha256:${"b".repeat(64)}`,
      ),
    ).toContain("registry.example%3A5000/team/node%3Av1");
  });
  it.each([
    "foo?bar",
    "foo#bar",
    "../foo",
    "foo/../bar",
    "foo//bar",
    "https://registry/foo",
    "foo%2fbar",
    "foo\\bar",
    "foo\u0000bar",
    "foo bar",
  ])("rejects unsafe repository %s", (repository) => {
    expect(() =>
      dockerImageReferencePath(`${repository}@sha256:${"a".repeat(64)}`),
    ).toThrow(RangeError);
  });
});
