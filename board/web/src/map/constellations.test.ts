import { describe, expect, it } from "vitest";
import { constellationsOf } from "./constellations";

const DATA = {
  constellations: [
    { name: "MyWallet", repos: ["mytonwallet-*", "my-pulse", "mytonwallet.io-v2"] },
    { name: "Wide", repos: ["*"] },
    { name: "Empty", repos: ["nothing-here"] },
  ],
  error: null,
};

describe("constellations", () => {
  it("puts each repository in the first constellation that names it, and drops the empty ones", () => {
    const list = constellationsOf(DATA, ["mytonwallet-frontend", "my-pulse", "gothic", "mytonwallet.io-v2", "my-support"]);
    expect(list.map((item) => [item.name, item.repos])).toEqual([
      ["MyWallet", ["my-pulse", "mytonwallet-frontend", "mytonwallet.io-v2"]],
      ["Wide", ["gothic", "my-support"]],
    ]);
  });

  it("matches a dot as a dot and a star as any run, the whole name only", () => {
    const data = { constellations: [{ name: "A", repos: ["a.b", "x*z"] }], error: null };
    expect(constellationsOf(data, ["a.b", "aXb", "xz", "xyz", "xyzz", "wxyz"])[0]!.repos).toEqual(["a.b", "xyzz", "xz", "xyz"].sort());
  });

  it("gives every constellation its own colour and none without data", () => {
    const list = constellationsOf(DATA, ["mytonwallet-x", "y"]);
    expect(new Set(list.map((item) => item.color)).size).toBe(2);
    expect(constellationsOf(null, ["a"])).toEqual([]);
  });
});
