import { expect, test } from "@playwright/test";

test("opens a clearly labeled demo office and switches the selected workstation", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  const office = page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "AI Office" });
  await office.click();
  await expect(page.getByRole("heading", { name: "AI Office", exact: true })).toBeVisible();
  await expect(office).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Simulated activity · No live connection")).toBeVisible();
  await expect(page.getByText("Demo data", { exact: true })).toBeVisible();
  const workstations = page.getByRole("region", { name: "Workstations" });
  await expect(workstations.getByRole("button")).toHaveCount(12);
  for (const status of ["idle", "queued", "working", "completed", "failed"]) {
    await expect(workstations.getByText(status, { exact: true }).first()).toBeVisible();
  }

  const details = page.getByRole("region", { name: "Agent details" });
  await expect(details.getByRole("heading", { name: "Scout" })).toBeVisible();
  await page.getByRole("button", { name: "Guard workstation" }).click();
  await expect(details.getByRole("heading", { name: "Guard" })).toBeVisible();
  await expect(details.getByText("Verify source references")).toBeVisible();
  await expect(details.getByText("Source references were unavailable")).toBeVisible();
  await expect(details.getByRole("progressbar")).toHaveAttribute("value", "40");
  await expect(workstations.getByRole("button", { name: "Scout workstation" })).toHaveAttribute("aria-pressed", "false");
  await expect(workstations.getByRole("button", { name: "Guard workstation" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Workflow" }).getByText("1 failed")).toBeVisible();
  await expect(page.getByRole("region", { name: "Activity timeline" }).getByRole("listitem")).toHaveCount(4);
  await expect(page.getByRole("region", { name: "API usage" }).getByText("$0.1166", { exact: true })).toBeVisible();
});

test("office stays within viewport and focuses agent details on mobile", async ({ page }) => {
  await page.goto("/ai-office");
  for (const width of [390, 680, 920, 1080, 1536]) {
    await page.setViewportSize({ width, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("link", { name: "AI Office" })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.getByRole("button", { name: "Pixel workstation" }).click();
  const details = page.getByRole("region", { name: "Agent details" });
  await expect(details).toBeFocused();
  await expect(details.getByText("No task assigned")).toBeVisible();
  await expect(details.getByRole("link", { name: "Back to Pixel workstation" })).toBeVisible();
});

test("desktop WebGL overview shows twelve readable stations and can pan, zoom and reset", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ai-office");
  const workstations = page.getByRole("region", { name: "Workstations" });
  const camera = page.getByRole("group", { name: "Office camera" });
  const labels = workstations.getByRole("button", { name: /workstation ·/ });
  await expect(labels).toHaveCount(12, { timeout: 15_000 });
  const canvas = workstations.locator("canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();

  for (const label of await labels.all()) {
    const box = await label.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThan(bounds!.x);
    expect(box!.y).toBeGreaterThan(bounds!.y);
    expect(box!.x + box!.width).toBeLessThan(bounds!.x + bounds!.width);
    expect(box!.y + box!.height).toBeLessThan(bounds!.y + bounds!.height);
    expect(box!.y + box!.height).toBeLessThan(900);
  }

  const scout = workstations.getByRole("button", { name: "Scout workstation · working", exact: true });
  const origin = await scout.boundingBox();
  await camera.getByRole("button", { name: "Zoom in" }).click();
  await expect.poll(async () => (await scout.boundingBox())?.x).not.toBe(origin!.x);
  await camera.getByRole("button", { name: "Reset camera" }).click();
  await expect.poll(async () => (await scout.boundingBox())?.x).toBe(origin!.x);

  await page.mouse.move(bounds!.x + 45, bounds!.y + 45);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 80, bounds!.y + 55, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await scout.boundingBox())?.x).not.toBe(origin!.x);
  await camera.getByRole("button", { name: "Reset camera" }).click();
  await expect.poll(async () => (await scout.boundingBox())?.x).toBe(origin!.x);

  await workstations.getByRole("button", { name: "Nova workstation · working" }).click();
  await expect(page.getByRole("region", { name: "Agent details" }).getByRole("heading", { name: "Nova" })).toBeVisible();
  await workstations.getByRole("button", { name: "Switch to 2D" }).click();
  await expect(workstations.getByRole("button", { name: "Nova workstation", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("desktop automatically shows 2D when WebGL cannot initialize", async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type.startsWith("webgl")) return null;
      return Reflect.apply(getContext, this, [type, ...args]);
    } as typeof getContext;
  });
  await page.goto("/ai-office");
  await expect(page.getByText("3D is unavailable on this device.", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Scout workstation", exact: true })).toBeVisible();
});
