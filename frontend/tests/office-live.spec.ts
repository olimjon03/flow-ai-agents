import { expect, test } from "@playwright/test";

test("the 3D office receives real simulated task events and reconnects to the latest snapshot", async ({ page, request }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ai-office");
  const start = page.getByRole("button", { name: "Start demo task" });
  const detail = page.getByRole("region", { name: "Agent details" });
  await expect(page.getByText("Live backend · Simulated agents")).toBeVisible();
  await expect(page.getByRole("button", { name: "Scout workstation · idle" })).toBeVisible();
  await expect(detail.getByText("No task assigned")).toBeVisible();

  await start.click();
  await expect(start).toBeDisabled();
  await expect(page.getByText("Demo workflow running")).toBeVisible();
  await expect(detail.getByText("Scan content trends", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scout workstation · working" })).toBeVisible();
  await expect.poll(async () => Number(await detail.getByRole("progressbar").getAttribute("value"))).toBeGreaterThan(0);
  await expect(detail.getByText(/Scan content trends · \d+%/)).toBeVisible();

  const duplicate = await request.post("/api/office/tasks", { data: {} });
  expect(duplicate.status()).toBe(409);

  // A new connection gets current state without waiting for a later run.
  const second = await page.context().newPage();
  await second.setViewportSize({ width: 1024, height: 768 });
  await second.goto("/ai-office");
  await expect(second.getByText("Live backend · Simulated agents")).toBeVisible();
  await expect(second.getByText("Demo workflow running")).toBeVisible();
  await second.close();

  await expect(page.getByText("Demo workflow completed")).toBeVisible({ timeout: 20_000 });
  await expect(start).toBeEnabled();
  await expect(page.getByRole("button", { name: /workstation · completed/ })).toHaveCount(12);
  const timeline = page.getByRole("region", { name: "Activity timeline" });
  await expect(timeline.getByText("Completed: Prepare release checklist")).toBeVisible();
  const usage = page.getByRole("region", { name: "API usage" });
  await expect(usage.getByText("$0.000", { exact: true })).toBeVisible();
});
