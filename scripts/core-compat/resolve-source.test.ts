import { describe, expect, test } from "bun:test";
import { resolveSource } from "./resolve-source";

const source = {
  repository: "owner/core-lite",
  developmentRef: "develop",
  pinnedCommit: "",
};

describe("resolveSource", () => {
  test("an empty pin follows the development ref", () => {
    expect(resolveSource({ source })).toEqual({
      repository: "owner/core-lite",
      ref: "develop",
    });
  });

  test("a non-empty pin selects the exact commit", () => {
    expect(
      resolveSource({
        source: { ...source, pinnedCommit: "a".repeat(40) },
      }),
    ).toEqual({
      repository: "owner/core-lite",
      ref: "a".repeat(40),
    });
  });

  test("an explicit source overrides the pin", () => {
    expect(
      resolveSource({
        source: { ...source, pinnedCommit: "not-a-commit" },
        repositoryOverride: "new/core-lite",
        refOverride: "candidate",
      }),
    ).toEqual({
      repository: "new/core-lite",
      ref: "candidate",
    });
  });

  test("rejects an incomplete repository override", () => {
    expect(() =>
      resolveSource({
        source,
        repositoryOverride: "new/core-lite",
      }),
    ).toThrow("requires a ref override");
  });

  test("rejects a malformed pin", () => {
    expect(() =>
      resolveSource({
        source: { ...source, pinnedCommit: "not-a-commit" },
      }),
    ).toThrow("must be empty or a full lowercase commit SHA");
  });

  test("rejects an empty pin and development ref", () => {
    expect(() =>
      resolveSource({
        source: { ...source, developmentRef: "" },
      }),
    ).toThrow("developmentRef must not be empty");
  });
});
