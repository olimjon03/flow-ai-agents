import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";

test("produces, previews, downloads and reviews a persisted 30-second vertical mock project", async ({ page, request }) => {
  test.setTimeout(65_000);
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.goto("/media-studio");
  await page.getByLabel("Topic", { exact: true }).fill("Local gardens");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Local gardens", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start mock workflow" }).click();
  await expect(page.getByRole("heading", { name: "Storyboard and editing timeline" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^awaiting script approval$/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Scene [1-5] ·/ })).toHaveCount(5);

  const office = await page.context().newPage();
  await office.setViewportSize({ width: 1536, height: 900 });
  await office.emulateMedia({ reducedMotion: "reduce" });
  await office.goto("/ai-office");
  await expect(office.getByText("Live backend · Simulated agents")).toBeVisible();
  await page.getByRole("button", { name: "Approve script and storyboard" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^awaiting approval$/ })).toBeVisible({ timeout: 35_000 });
  for (const agent of ["Pixel", "Echo", "Frame", "Relay"]) {
    await expect(office.getByRole("button", { name: `${agent} workstation`, exact: true })).toHaveAccessibleDescription("Status: completed");
  }
  await office.close();

  await expect(page.getByRole("img", { name: /Mock image for scene/ })).toHaveCount(5);
  await expect(page.getByLabel(/Placeholder tone/)).toBeVisible();
  await expect(page.getByLabel("Scene 1 video")).toBeVisible();
  const final = page.getByLabel("Final MP4");
  await expect(final).toBeVisible();
  await expect.poll(() => final.evaluate((element: HTMLVideoElement) => element.videoHeight)).toBe(640);
  const download = await page.getByRole("link", { name: "Download MP4" }).getAttribute("href");
  const bytes = await request.get(download!, { headers: { Range: "bytes=0-63" } });
  expect(bytes.status()).toBe(206);
  expect(bytes.headers()["content-disposition"]).toContain("attachment");
  expect((await bytes.body()).toString("ascii")).toContain("ftyp");

  await page.getByLabel("Rejection feedback").fill("Review the pacing");
  await page.getByRole("button", { name: "Reject final video" }).click();
  await expect(page.getByText("Feedback · Review the pacing")).toBeVisible();
  await page.getByRole("button", { name: "Approve final video" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^approved$/ })).toBeVisible();
  const movingClip = execFileSync(process.env.FLOW_FFMPEG_BIN || "ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24",
    "-t", "1", "-c:v", "libx264", "-threads", "2", "-movflags", "frag_keyframe+empty_moov",
    "-f", "mp4", "pipe:1",
  ]);
  await page.getByLabel("Import MP4 for scene 1").setInputFiles({
    name: "motion.mp4", mimeType: "video/mp4", buffer: movingClip,
  });
  await expect(page.getByText("Imported MP4", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: /^awaiting approval$/ })).toBeVisible();
  const [projectPath, oldDownload] = download!.split("/assets/");
  const stale = await request.post(`${projectPath}/actions`, {
    data: { action: "approve", reviewedAssetId: oldDownload.split("?")[0] },
  });
  expect(stale.status()).toBe(409);
  await page.getByRole("button", { name: "Approve final video" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^approved$/ })).toBeVisible();
  const importedSource = await page.getByLabel("Scene 1 video").getAttribute("src");
  const approvedSource = await final.getAttribute("src");
  for (const stage of ["video", "image"]) {
    await page.getByLabel("Regenerate stage").selectOption(stage);
    await expect(page.getByLabel("Replace imported clips with generated clips")).not.toBeChecked();
    await page.getByRole("button", { name: "Regenerate", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /^awaiting approval$/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("Scene 1 video")).toHaveAttribute("src", importedSource!);
    await expect(page.getByRole("link", { name: "Download last approved MP4" }))
      .toHaveAttribute("href", `${approvedSource}?download=true`);
    const retained = await request.get(approvedSource!, { headers: { Range: "bytes=0-63" } });
    expect(retained.status()).toBe(206);
  }
  await page.getByRole("button", { name: "Approve final video" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^approved$/ })).toBeVisible();
  const archived = await request.get(approvedSource!, { headers: { Range: "bytes=0-63" } });
  expect(archived.status()).toBe(206);
  await page.reload();
  await expect(page.getByRole("status").filter({ hasText: /^approved$/ })).toBeVisible();
  await expect(page.getByLabel("Final MP4")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});
