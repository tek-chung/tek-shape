import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const PAGE_SIZE = 8;

// Service access to the DISPOSABLE test project only (global setup refuses the personal one).
const admin = createClient(process.env.PLAYWRIGHT_SUPABASE_URL ?? "", process.env.PLAYWRIGHT_SUPABASE_SERVICE_ROLE_KEY ?? "", {
  auth: { persistSession: false, autoRefreshToken: false },
});
async function testUserId() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const users: { id: string; email?: string }[] = data?.users ?? [];
  return users.find((user) => user.email === "playwright@tek-shape.test")!.id;
}

// Read posts leave the feed on the next visit, and cards on screen for five seconds or touched by any
// control count as read, so start every test with a clean slate (test account, disposable project);
// otherwise the first card would differ from test to test.
test.beforeEach(async () => {
  await admin.from("user_post_state").delete().eq("user_id", await testUserId());
});

/** The feed is ready once the first page of content has arrived. */
async function openFeed(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Explore something different" })).toBeVisible();
  await expect(page.locator("article")).toHaveCount(PAGE_SIZE);
}

const card = (page: Page, index = 0) => page.locator("article").nth(index);
const control = (page: Page, name: string, index = 0) =>
  card(page, index).getByRole("button", { name, exact: true });

test("signs in from stored session and shows the first page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openFeed(page);
  await expect(page.getByText("PRIVATE READING")).toBeVisible();
  await expect(card(page).getByRole("button")).toHaveCount(5);
  expect(errors).toEqual([]);
});

test("ratings are exclusive, bookmarks are independent, and both survive a reload", async ({ page }) => {
  await openFeed(page);
  const first = await card(page).getAttribute("id");
  await control(page, "More at the same level").click();
  await control(page, "Save post").click();
  await control(page, "Not interesting").click();
  await expect(control(page, "More at the same level")).toHaveAttribute("aria-pressed", "false");
  await expect(control(page, "Not interesting")).toHaveAttribute("aria-pressed", "true");
  await control(page, "Keep the topic, increase difficulty").click();
  await expect(control(page, "Not interesting")).toHaveAttribute("aria-pressed", "false");
  await expect(control(page, "Remove bookmark")).toHaveAttribute("aria-pressed", "true");
  await expect(card(page, 1).locator('[aria-pressed="true"]')).toHaveCount(0);

  // Rated and saved in this sitting, so it stays put until the next one.
  await expect(card(page)).toHaveAttribute("id", first!);

  // Wait for the outbox to drain, so the reload reads it back from Supabase. Touching a control counts as
  // reading, so after the reload the post has left the feed; the Library shows it with both choices kept.
  await expect(page.getByText("Saved to your account")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Explore something different" })).toBeVisible();
  await expect(page.locator(`article[id="${first}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Library" }).click();
  const saved = page.locator(`article[id="${first}"]`);
  await expect(saved.getByRole("button", { name: "Keep the topic, increase difficulty", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(saved.getByRole("button", { name: "Remove bookmark", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a post rated on an older app, with no read time recorded, leaves the feed on Refresh", async ({ page }) => {
  await openFeed(page);
  const first = await card(page).getAttribute("id");
  // As an older version of the app left it: rated, but never marked read.
  await admin
    .from("user_post_state")
    .upsert({ user_id: await testUserId(), post_id: first!, rating: "harder", read_at: null }, { onConflict: "user_id,post_id" });
  await page.getByRole("button", { name: /Refresh/ }).click();
  await expect(page.locator(`article[id="${first}"]`)).toHaveCount(0);
});

test("the deeper explanation opens only on its own post", async ({ page }) => {
  await openFeed(page);
  await control(page, "Expand deeper explanation").click();
  await expect(card(page).getByRole("heading", { name: "A little deeper" })).toBeVisible();
  await expect(card(page, 1).locator(".deeper")).toBeHidden();
  await control(page, "Collapse deeper explanation").click();
  await expect(card(page).locator(".deeper")).toBeHidden();
});

test("the Library holds saved posts and empties cleanly", async ({ page }) => {
  await openFeed(page);
  await control(page, "Save post").click();
  await expect(control(page, "Remove bookmark")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Library" }).click();
  await expect(page.locator("article")).toHaveCount(1);
  await control(page, "Remove bookmark").click();
  await expect(page.locator("article")).toHaveCount(0);
  await expect(page.getByText("Your next good idea belongs here.")).toBeVisible();
  await page.getByRole("button", { name: "Your feed", exact: true }).click();
  await expect(page.locator("article")).toHaveCount(PAGE_SIZE);
});

test("posts read on an earlier visit move from the feed to Read", async ({ page }) => {
  await openFeed(page);
  const first = await card(page).getAttribute("id");
  await admin
    .from("user_post_state")
    .upsert({ user_id: await testUserId(), post_id: first!, read_at: "2026-01-01T00:00:00Z" }, { onConflict: "user_id,post_id" });
  await page.reload();
  await expect(page.locator("article")).toHaveCount(PAGE_SIZE);
  await expect(card(page)).not.toHaveAttribute("id", first!);
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page.locator(`article[id="${first}"]`)).toBeVisible();
});

test("Refresh moves posts read earlier to Read without reloading the page", async ({ page }) => {
  await openFeed(page);
  const first = await card(page).getAttribute("id");
  await admin
    .from("user_post_state")
    .upsert({ user_id: await testUserId(), post_id: first!, read_at: "2026-01-01T00:00:00Z" }, { onConflict: "user_id,post_id" });
  await page.getByRole("button", { name: /Refresh/ }).click();
  await expect(card(page)).not.toHaveAttribute("id", first!);
  await expect(page.locator(`article[id="${first}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Read", exact: true }).click();
  await expect(page.locator(`article[id="${first}"]`)).toBeVisible();
});

test("scrolling to the end pages in more content and stops at the last post", async ({ page }) => {
  await openFeed(page);
  // The global setup seeds beyond one page, so this genuinely exercises the cursor.
  await page.locator("article").last().scrollIntoViewIfNeeded();
  await expect
    .poll(async () => page.locator("article").count(), { timeout: 15_000 })
    .toBeGreaterThan(PAGE_SIZE);

  // Keep scrolling until the feed is exhausted.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await page.getByText("A good place to pause.").isVisible().catch(() => false)) break;
    await page.locator("article").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
  }
  await expect(page.getByText("A good place to pause.")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Keep scrolling", exact: true })).toHaveCount(0);

  // No duplicates: the cursor must not re-serve a page.
  const ids = await page.locator("article").evaluateAll((nodes) => nodes.map((node) => node.id));
  expect(new Set(ids).size).toBe(ids.length);
});

test("reading position is restored after a reload", async ({ page }) => {
  await openFeed(page);
  const anchor = page.locator("article").nth(3);
  await anchor.evaluate((element) => window.scrollTo(0, element.getBoundingClientRect().top + window.scrollY + 90));
  await expect(page.getByText("Saved to your account")).toBeVisible({ timeout: 15_000 });
  const before = await page.evaluate(() => window.scrollY);
  expect(before).toBeGreaterThan(0);

  await page.reload();
  await expect(page.locator("article")).toHaveCount(PAGE_SIZE);
  await expect.poll(async () => Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThan(40);
});

test("writes made offline are kept and sync on reconnect", async ({ page, context }) => {
  await openFeed(page);
  await context.setOffline(true);
  await control(page, "Save post").click();
  // The interface updates immediately even with no connection.
  await expect(control(page, "Remove bookmark")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Saved on this device")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("Saved to your account")).toBeVisible({ timeout: 20_000 });
});

for (const width of [320, 360, 390]) {
  test(`no horizontal overflow and usable controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openFeed(page);
    for (const button of await page.locator(".feedback button[aria-expanded]").all()) await button.click();
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
  });
}
