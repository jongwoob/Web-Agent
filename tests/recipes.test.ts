import { describe, expect, it } from "vitest";
import { checkRecipes } from "../src/recipes/checkRecipes.js";

describe("recipe catalog", () => {
  it("has complete front matter and valid active commands", async () => {
    const result = await checkRecipes();

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.files.length).toBeGreaterThanOrEqual(15);
  });
});
