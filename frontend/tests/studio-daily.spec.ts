import { expect, test } from "@playwright/test";

test("persists daily settings, gates activation on a dry run and queues a mock video", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/settings");
  const panel = page.getByRole("region", { name: "Daily Video Settings" });
  await expect(panel.getByLabel("Videos per day")).toHaveValue("1");
  await expect(panel.getByLabel("Start time")).toHaveValue("06:00");
  await expect(panel.getByLabel("Timezone")).toHaveValue("Asia/Seoul");
  await expect(panel.getByLabel("Enable scheduling")).toBeChecked();
  const activate = panel.getByRole("button", { name: "Activate mock schedule" });
  await expect(activate).toBeDisabled();
  await panel.getByLabel("Videos per day").selectOption("2");
  await panel.getByLabel("Start time").fill("23:59");
  const saved = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/daily-video"
    && response.request().method() === "POST" && response.request().postDataJSON().action === "save");
  await panel.getByRole("button", { name: "Save settings" }).click();
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(panel.getByLabel("Videos per day")).toHaveValue("2");
  await panel.getByRole("button", { name: "Run dry run" }).click();
  await expect(panel.getByText("Dry run complete.", { exact: false })).toBeVisible();
  await expect(panel.getByRole("list", { name: "Recent daily video jobs" })).toHaveCount(0);
  await activate.click();
  await expect(panel.getByText("Mock schedule active", { exact: false })).toBeVisible();
  await panel.getByRole("button", { name: "Pause schedule" }).click();
  await expect(panel.getByText("Schedule paused", { exact: false })).toBeVisible();
  await panel.getByRole("button", { name: "Resume schedule" }).click();
  await expect(panel.getByText("Mock schedule active", { exact: false })).toBeVisible();
  await panel.getByRole("button", { name: "Generate Now" }).click();
  const job = panel.getByRole("list", { name: "Recent daily video jobs" }).getByRole("listitem");
  await expect(job).toContainText("manual · completed · Mock Chrome profile 1", { timeout: 30_000 });
  await job.getByRole("link").click();
  await expect(page.getByRole("status").filter({ hasText: /^awaiting approval$/ })).toBeVisible();
  await expect(page.getByLabel("Final MP4")).toBeVisible();
});
