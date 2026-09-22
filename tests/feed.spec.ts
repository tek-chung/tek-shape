import { expect, test } from "@playwright/test";

const key = "tek-shape:reading:v1";
test("four plus four, exclusive ratings, independent saves, deeper reading and reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("article")).toHaveCount(4);
  const first = page.locator("article").first();
  const second = page.locator("article").nth(1);
  await expect(first.getByRole("button")).toHaveCount(5);
  await first.getByRole("button", { name: "More at the same level", exact: true }).click();
  await first.getByRole("button", { name: "Save post", exact: true }).click();
  await first.getByRole("button", { name: "Not interesting", exact: true }).click();
  await expect(first.getByRole("button", { name: "More at the same level", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(first.getByRole("button", { name: "Not interesting", exact: true })).toHaveAttribute("aria-pressed", "true");
  await first.getByRole("button", { name: "Keep the topic, increase difficulty", exact: true }).click();
  await expect(first.getByRole("button", { name: "Not interesting", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(first.getByRole("button", { name: "Remove bookmark", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(second.locator('[aria-pressed="true"]')).toHaveCount(0);
  await first.getByRole("button", { name: "Expand deeper explanation", exact: true }).click();
  await expect(first.getByRole("heading", { name: "A little deeper" })).toBeVisible();
  await expect(second.locator(".deeper")).toBeHidden();
  await page.reload();
  await expect(first.getByRole("button", { name: "Keep the topic, increase difficulty", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(first.getByRole("button", { name: "Remove bookmark", exact: true })).toHaveAttribute("aria-pressed", "true");
  await first.getByRole("button", { name: "Collapse deeper explanation", exact: true }).click();
  await expect(first.locator(".deeper")).toBeHidden();
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.locator("article")).toHaveCount(1);
  await first.getByRole("button", { name: "Remove bookmark", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(0);
  await expect(page.getByText("Your next good idea belongs here.")).toBeVisible();
  await page.getByRole("button", { name: "Your feed", exact: true }).click();
  await first.getByRole("button", { name: "Keep the topic, increase difficulty", exact: true }).click();
  await expect(first.locator('[aria-pressed="true"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Keep scrolling", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(8);
  await expect(page.getByRole("button", { name: "Keep scrolling", exact: true })).toHaveCount(0);
  await expect(page.locator("article .sample")).toHaveCount(8);
  expect(new Set(await page.locator(".topic").allTextContents()).size).toBe(8);
  expect(errors).toEqual([]);
});

test("reading position restores into the second batch and survives a Library visit", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Keep scrolling", exact: true }).click();
  await page.locator("#computing-binary").evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY + 90));
  await expect.poll(() => page.evaluate((storageKey) => JSON.parse(localStorage.getItem(storageKey)!).position?.postId, key)).toBe("computing-binary");
  const before = await page.evaluate(() => window.scrollY);
  await page.reload();
  await expect(page.locator("article")).toHaveCount(8);
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - before)).toBeLessThan(5);
  // Programmatic activation avoids scrolling the navigation into view first.
  await page.getByRole("button", { name: "Library" }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByText("Your next good idea belongs here.")).toBeVisible();
  await page.getByRole("button", { name: "Your feed", exact: true }).click();
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - before)).toBeLessThan(5);
});

for (const width of [320, 360, 390]) {
  test(`no horizontal overflow and usable controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "Keep scrolling", exact: true }).click();
    for (const button of await page.locator('.feedback button[aria-expanded]').all()) await button.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const button of await page.locator(".feedback button").all()) {
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(await button.getAttribute("aria-label")).toBeTruthy();
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `test-results/feed-${width}.png`, fullPage: true });
    await page.screenshot({ path: `test-results/viewport-${width}.png` });
  });
}

test("malformed storage falls back safely", async ({ page }) => {
  await page.addInitScript((storageKey) => localStorage.setItem(storageKey, "{broken"), key);
  await page.goto("/");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("could not be loaded");
  await expect(page.locator("article")).toHaveCount(4);
  await page.locator("article").first().getByRole("button", { name: "Save post", exact: true }).click();
  await expect(page.locator("article").first().getByRole("button", { name: "Remove bookmark", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("blocked storage leaves the feed usable with an honest notice", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new Error("Blocked"); };
    Storage.prototype.setItem = () => { throw new Error("Blocked"); };
  });
  await page.goto("/");
  await page.locator("article").first().getByRole("button", { name: "Save post", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("only while this page stays open");
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.locator("article")).toHaveCount(1);
});
