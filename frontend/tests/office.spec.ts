import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // These tests exercise the offline preview; the live suite uses the actual SSE endpoint.
  await page.route("**/api/office/events", (route) => route.abort());
});

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
  await expect(workstations.getByRole("button", { name: /workstation$/ })).toHaveCount(12);
  for (const status of ["idle", "queued", "working", "completed", "failed"]) {
    await expect(workstations.getByText(status, { exact: true }).first()).toBeVisible();
  }

  const details = page.getByRole("region", { name: "Agent details" });
  await expect(details.getByRole("heading", { name: "Scout" })).toBeVisible();
  await expect(details.getByText("Simulated status and activity")).toBeVisible();
  await page.getByRole("button", { name: "Guard workstation" }).click();
  await expect(details.getByRole("heading", { name: "Guard" })).toBeVisible();
  await expect(details.getByText("Verify source references")).toBeVisible();
  await expect(details.getByText("Source references were unavailable")).toBeVisible();
  await expect(details.getByRole("progressbar")).toHaveAttribute("value", "40");
  await expect(workstations.getByRole("button", { name: "Scout workstation" })).toHaveAttribute("aria-pressed", "false");
  await expect(workstations.getByRole("button", { name: "Guard workstation" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Workflow" }).getByText("1 failed")).toBeVisible();
  await expect(page.getByRole("region", { name: "Activity timeline" }).getByRole("listitem")).toHaveCount(4);
  await expect(page.getByRole("region", { name: "Activity timeline" }).getByText("Simulated activity log")).toBeVisible();
  const usage = page.getByRole("region", { name: "API usage" });
  await expect(usage.getByText("Demo estimated cost")).toBeVisible();
  await expect(usage.getByText("$0.1166", { exact: true })).toBeVisible();
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
  await page.mouse.down({ button: "right" });
  await page.mouse.move(bounds!.x + 80, bounds!.y + 55, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await expect.poll(async () => (await scout.boundingBox())?.x).not.toBe(origin!.x);
  await camera.getByRole("button", { name: "Reset camera" }).click();
  await expect.poll(async () => (await scout.boundingBox())?.x).toBe(origin!.x);

  await canvas.focus();
  await page.keyboard.press("ArrowLeft");
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


test("WebGL avatars animate only when visible and motion is allowed", async ({ page }) => {
  await page.addInitScript(() => {
    const gl = WebGL2RenderingContext.prototype;
    const clear = gl.clear;
    let frames = 0;
    const drawElements = gl.drawElements;
    const drawArrays = gl.drawArrays;
    let draws = 0;
    gl.clear = function (mask) {
      if (mask & this.COLOR_BUFFER_BIT) frames++;
      clear.call(this, mask);
    };
    gl.drawElements = function (...args) {
      draws++;
      drawElements.apply(this, args);
    };
    gl.drawArrays = function (...args) {
      draws++;
      drawArrays.apply(this, args);
    };
    Object.assign(window, { readOfficeGl: () => ({ frames, draws }) });
  });
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.goto("/ai-office");
  await expect(page.getByRole("button", { name: "Scout workstation · working" })).toBeVisible();
  const canvas = page.locator(".office-scene canvas");
  const readGl = () => page.evaluate(() => (window as Window & {
    readOfficeGl?: () => { frames: number; draws: number };
  }).readOfficeGl!());

  const first = await canvas.screenshot();
  const start = await readGl();
  const startMs = Date.now();
  await expect.poll(async () => (await readGl()).frames - start.frames).toBeGreaterThanOrEqual(8);
  const end = await readGl();
  const elapsed = Date.now() - startMs;
  const frameCount = end.frames - start.frames;
  const drawCallsPerFrame = (end.draws - start.draws) / frameCount;
  console.log(`Office WebGL smoke: ${frameCount} frames in ${elapsed} ms, ~${drawCallsPerFrame.toFixed(0)} draw calls/frame`);
  expect(drawCallsPerFrame).toBeGreaterThan(0);
  expect(drawCallsPerFrame).toBeLessThan(500);
  expect((await canvas.screenshot()).equals(first)).toBe(false);

  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "200vh";
    document.body.append(spacer);
    window.scrollTo(0, document.body.scrollHeight);
  });
  await expect.poll(async () => {
    const before = await readGl();
    await new Promise((resolve) => setTimeout(resolve, 250));
    return (await readGl()).frames - before.frames;
  }).toBe(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  const paused = await readGl();
  await expect.poll(async () => (await readGl()).frames).toBeGreaterThan(paused.frames + 2);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(async () => {
    const before = await readGl();
    await new Promise((resolve) => setTimeout(resolve, 250));
    return (await readGl()).frames - before.frames;
  }).toBe(0);
});

test("orbits through a full turn and switches top and isometric presets", async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ai-office");
  const scout = page.getByRole("button", { name: "Scout workstation · working", exact: true });
  const quill = page.getByRole("button", { name: "Quill workstation · working", exact: true });
  await expect(scout).toBeVisible();
  const canvas = page.locator(".office-scene canvas");
  const bounds = (await canvas.boundingBox())!;
  const readOrder = async () => (await scout.boundingBox())!.x - (await quill.boundingBox())!.x;
  const initial = await readOrder();

  async function halfTurn() {
    const x = bounds.x + 22;
    const y = bounds.y + 44;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + bounds.height / 2, y, { steps: 8 });
    await page.mouse.up();
  }

  await halfTurn();
  await expect.poll(readOrder).toBeGreaterThan(0);
  await halfTurn();
  await expect.poll(readOrder).toBeLessThan(0);
  expect(Math.abs(await readOrder() - initial)).toBeLessThan(5);

  const initialY = (await scout.boundingBox())!.y;
  await page.getByRole("button", { name: "Top view" }).click();
  await expect.poll(async () => (await scout.boundingBox())!.y).not.toBe(initialY);
  await page.getByRole("button", { name: "Isometric" }).click();
  await expect.poll(async () => (await scout.boundingBox())!.y).toBe(initialY);
  await page.getByRole("button", { name: "Low graphics" }).click();
  await expect(page.getByRole("button", { name: "Low graphics" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Transparent walls" }).click();
  await expect(page.getByRole("button", { name: "Transparent walls" })).toHaveAttribute("aria-pressed", "true");
});
