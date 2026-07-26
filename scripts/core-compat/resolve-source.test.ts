import { describe, expect, test } from "bun:test";
import { resolveSource } from "./resolve-source";

const source = {
  repository: "owner/core-lite",
  developmentRef: "develop",
  pinnedCommit: "a".repeat(40),
};

describe("resolveSource", () => {
  test("defaults to the development ref", () => {
    expect(resolveSource({ source })).toEqual({
      repository: "owner/core-lite",
      ref: "develop",
      mode: "latest",
    });
  });

  test("uses the production pin", () => {
    expect(resolveSource({ source, repositoryMode: "pinned" })).toEqual({
      repository: "owner/core-lite",
      ref: "a".repeat(40),
      mode: "pinned",
    });
  });

  test("scheduled checks follow development", () => {
    expect(
      resolveSource({
        source,
        repositoryMode: "pinned",
        eventName: "schedule",
      }),
    ).toEqual({
      repository: "owner/core-lite",
      ref: "develop",
      mode: "latest",
    });
  });

  test("an explicit source overrides mode", () => {
    expect(
      resolveSource({
        source,
        requestedMode: "pinned",
        repositoryOverride: "new/core-lite",
        refOverride: "candidate",
      }),
    ).toEqual({
      repository: "new/core-lite",
      ref: "candidate",
      mode: "override",
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
});
