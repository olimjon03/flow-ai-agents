import { expect, test } from "@playwright/test";

test("all workspace sections open and highlight their navigation item", async ({ page }) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "Workspace" });

  for (const label of [
    "Dashboard", "Create Content", "AI Agents", "AI Office", "Projects", "Storyboard",
    "Media Library", "Publishing", "Analytics", "Settings",
  ]) {
    const link = nav.getByRole("link", { name: label, exact: true });
    await link.click();
    await expect(page.getByRole("heading", { name: label, level: 1, exact: true })).toBeVisible();
    await expect(link).toHaveAttribute("aria-current", "page");
  }
});

test("generates both sample formats through Python, edits and copies", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/create-content");
  await expect(page.getByText("Your draft will appear here.")).toBeVisible();
  const generate = page.getByRole("button", { name: "Generate draft" });
  const copy = page.getByRole("button", { name: "Copy" });
  await expect(copy).toBeDisabled();
  await generate.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Enter a content brief.");
  await page.getByLabel("Brief", { exact: true }).fill("Talabalar uchun vaqtni rejalash");
  await generate.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Choose a content format.");

  await page.getByLabel("Social post").check();
  await generate.click();
  const draft = page.getByLabel("Edit draft");
  await expect(draft).toHaveValue(/Talabalar uchun vaqtni rejalash/);
  await expect(page.getByText("Sample template")).toBeVisible();

  await page.getByLabel("Short video script").check();
  await generate.click();
  await expect(draft).toHaveValue(/20–30 soniya/);
  await draft.fill("Tahrirlangan matn");
  await copy.click();
  await expect(page.getByRole("status")).toHaveText("Draft copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Tahrirlangan matn");
});

test("shows loading and errors, preserves edits, and labels a simulated OpenAI reply", async ({ page }) => {
  await page.goto("/create-content");
  await page.getByLabel("Brief", { exact: true }).fill("Mening brifim");
  await page.getByLabel("Social post").check();
  const generate = page.getByRole("button", { name: "Generate draft" });
  await generate.click();
  const draft = page.getByLabel("Edit draft");
  await draft.fill("Oldingi tahrir");

  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/generate", async (route) => {
    await pending;
    await route.fulfill({ status: 502, json: { error: "Draft generation failed. Try again." } });
  });
  await generate.click();
  try {
    await expect(page.getByRole("button", { name: "Generating…" })).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Draft generation failed. Try again.");
  await expect(draft).toHaveValue("Oldingi tahrir");
  await page.unroute("**/api/generate");
  await page.route("**/api/generate", (route) =>
    route.fulfill({ json: { draft: "OpenAI sinov javobi", mode: "openai" } }));
  await generate.click();
  await expect(page.getByText("OpenAI generation", { exact: true })).toBeVisible();
  await expect(draft).toHaveValue("OpenAI sinov javobi");
});

test("mobile navigation and composer fit a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Open navigation" });
  await toggle.click();
  await expect(toggle).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.getByRole("navigation").getByRole("link", { name: "Create Content" }).click();
  await expect(page.getByRole("heading", { name: "Create Content", level: 1 })).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("the legacy prototype works and Python does not expose Next.js files", async ({ page, request }) => {
  await page.goto("http://127.0.0.1:8100/");
  await expect(page.getByRole("heading", { name: "Kontent ustaxonasi" })).toBeVisible();
  await page.getByLabel("Brif", { exact: true }).fill("Eski sahifadan sinov");
  await page.getByLabel("Ijtimoiy tarmoq posti").check();
  await page.getByRole("button", { name: "Qoralama yaratish" }).click();
  await expect(page.getByLabel("Qoralamani tahrirlash")).toHaveValue(/Eski sahifadan sinov/);

  for (const path of ["/.env.example", "/package.json", "/app/api/generate/route.ts"]) {
    const response = await request.get(`http://127.0.0.1:8100${path}`);
    expect(response.status()).toBe(404);
  }
});

test("original Python API accepts both formats and rejects invalid requests", async ({ request }) => {
  const endpoint = "http://127.0.0.1:8100/api/generate";
  for (const format of ["post", "video"]) {
    const response = await request.post(endpoint, { data: { brief: "O‘zbekcha sinov brifi", format } });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      draft: expect.stringContaining("O‘zbekcha sinov brifi"),
      mode: "sample",
    });
  }
  const invalid = await request.post(endpoint, { data: { brief: "Sinov", format: "unknown" } });
  expect(invalid.status()).toBe(400);
  expect(await invalid.json()).toHaveProperty("error");
});
