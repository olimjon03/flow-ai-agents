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
  await page.getByRole("button", { name: "Import scene 1", exact: true }).click();
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

test("imports five moving clips sequentially and approves the Uzbek export", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/media-studio");
  await page.getByLabel("Topic", { exact: true }).fill("Uzbek five-scene project");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Start mock workflow" }).click();
  await page.getByRole("button", { name: "Approve script and storyboard" }).click();
  const status = (value: string) => page.getByRole("status").filter({ hasText: new RegExp(`^${value}$`) });
  await expect(status("awaiting approval")).toBeVisible({ timeout: 35_000 });
  await expect(page.getByText("Mock-only video · no imported clips")).toBeVisible();
  await page.getByRole("button", { name: "Approve final video" }).click();
  await expect(status("approved")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Five-scene MP4 import" })).toBeVisible();

  const buffer = execFileSync(process.env.FLOW_FFMPEG_BIN || "ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24",
    "-t", "1", "-c:v", "libx264", "-threads", "2", "-movflags", "frag_keyframe+empty_moov",
    "-f", "mp4", "pipe:1",
  ]);
  const submitted: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/import")) submitted.push(request.url());
  });
  for (let scene = 5; scene >= 1; scene--) {
    await page.getByLabel(`Import MP4 for scene ${scene}`).setInputFiles({
      name: `sahna-${scene}.mp4`, mimeType: "video/mp4", buffer,
    });
  }
  await page.getByRole("button", { name: "Import selected clips in scene order" }).click();
  await expect(page.getByText("All 5 scenes use imported video")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Imported MP4", { exact: true })).toHaveCount(5);
  await expect(page.getByText(/Source 1\.00s → target 6s/)).toHaveCount(5);
  await expect(page.getByText("sahna-5.mp4", { exact: true })).toBeVisible();
  expect(submitted).toHaveLength(5);
  expect(new Set(submitted.map((url) => new URL(url).searchParams.get("expected_export"))).size).toBe(5);
  await expect(page.getByText("Subtitles · Uzbek", { exact: true })).toBeVisible();
  await expect(page.getByText("Voiceover · Bugun Uzbek five-scene project haqida gaplashamiz.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download last approved MP4" })).toBeVisible();
  await page.getByRole("button", { name: "Approve final video" }).click();
  await expect(status("approved")).toBeVisible();
  await expect(page.getByRole("region", { name: "Studio storage" }).getByText(/Archived exports · [1-9]/)).toBeVisible();
  await page.route("**/api/studio/storage", async (route) => {
    const response = await route.fetch();
    const storage = await response.json();
    await route.fulfill({ json: { ...storage, freeBytes: 0, renderPaused: true } });
  });
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: /Rendering paused/ })).toBeVisible();
  await page.getByLabel("Regenerate stage").selectOption("video");
  await expect(page.getByRole("button", { name: "Regenerate", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Download MP4", exact: true })).toBeVisible();
});

test("keeps selected files across unrelated exports, stale confirmation and cancellation", async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.goto("/media-studio");
  await page.getByLabel("Topic", { exact: true }).fill("Concurrent import review");
  await page.getByRole("button", { name: "Create project" }).click();
  await page.getByRole("button", { name: "Start mock workflow" }).click();
  await page.getByRole("button", { name: "Approve script and storyboard" }).click();
  const status = (value: string) => page.getByRole("status").filter({ hasText: new RegExp(`^${value}$`) });
  await expect(status("awaiting approval")).toBeVisible({ timeout: 35_000 });
  const final = page.getByLabel("Final MP4");
  const projectPath = (await final.getAttribute("src"))!.split("/assets/")[0];
  const other = await page.context().newPage();
  await other.goto("/media-studio");
  const initial = await (await other.request.get(projectPath)).json();
  const scene = initial.scenes[0].id;
  const importPath = `${projectPath}/scenes/${scene}/import`;
  const moving = execFileSync(process.env.FLOW_FFMPEG_BIN || "ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24",
    "-t", "1", "-c:v", "libx264", "-threads", "2", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1",
  ]);
  const corrupt = moving.subarray(0, moving.readUInt32BE());
  const selection = (number: number, name: string, buffer: Buffer) =>
    page.getByLabel(`Import MP4 for scene ${number}`).setInputFiles({ name, mimeType: "video/mp4", buffer });
  const announcement = page.locator('p[aria-live="polite"][aria-atomic="true"]');
  let uploads = 0;
  page.on("request", (outgoing) => {
    if (outgoing.method() === "POST" && new URL(outgoing.url()).pathname.endsWith("/import")) uploads++;
  });

  const polling = "**/api/studio/projects/*/imports/*";
  await page.route(polling, async (route) => {
    const operationUrl = new URL(route.request().url()).pathname;
    await expect.poll(async () => {
      const result = await other.request.get(operationUrl);
      return (await result.json()).operation.status;
    }, { timeout: 20_000 }).toBe("failed");
    const regenerated = await other.request.post(`${projectPath}/actions`, { data: { action: "regenerate", stage: "editor" } });
    expect(regenerated.ok()).toBe(true);
    await expect.poll(async () => (await (await other.request.get(projectPath)).json()).status,
      { timeout: 20_000 }).toBe("awaiting_approval");
    const exact = await other.request.get(operationUrl);
    await route.fulfill({ json: await exact.json() });
  }, { times: 1 });
  await selection(1, "broken.mp4", corrupt);
  await selection(2, "second.mp4", moving);
  await page.getByRole("button", { name: "Import selected clips in scene order" }).click();
  await expect(announcement).toContainText("Scene 1. Import stopped", { timeout: 25_000 });
  await expect(page.getByText("Selected · broken.mp4")).toBeVisible();
  await expect(page.getByText("Selected · second.mp4")).toBeVisible();
  expect(uploads).toBe(1);
  await expect(status("awaiting approval")).toBeVisible();

  await selection(1, "first.mp4", moving);
  await page.getByRole("button", { name: "Import scene 1", exact: true }).click();
  await expect(announcement).toHaveText("Scene 1. Imported", { timeout: 20_000 });
  const imported = await (await other.request.get(projectPath)).json();
  const oldClip = imported.assets.find((item: { sceneId: string; provider: string }) =>
    item.sceneId === scene && item.provider === "manual");
  await selection(1, "local-replacement.mp4", moving);
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256").update(moving).digest("hex");
  const replaced = await other.request.post(`${importPath}?expected_export=${imported.finalAssetId}&replace_asset=${oldClip.id}`, {
    data: moving, headers: { "Content-Type": "video/mp4", "X-Flow-Clip-Sha256": digest },
  });
  expect(replaced.status()).toBe(202);
  const operationId = (await replaced.json()).importOperationId;
  await expect.poll(async () => (await (await other.request.get(`${projectPath}/imports/${operationId}`)).json()).operation.status,
    { timeout: 20_000 }).toBe("succeeded");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Import scene 1", exact: true }).click();
  await expect(announcement).toContainText("Scene 1. Import stopped");
  await expect(page.getByText("Selected · local-replacement.mp4")).toBeVisible();

  const latest = await (await request.get(projectPath)).json();
  const target = latest.assets.find((item: { sceneId: string; provider: string }) =>
    item.sceneId === scene && item.provider === "manual");
  const controlledOperation = "a".repeat(32);
  let cancelled = false;
  await page.route(`**${importPath}?*`, (route) =>
    route.fulfill({ status: 202, json: { ...latest, status: "working", importOperationId: controlledOperation } }));
  await page.route(`**${projectPath}/actions`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ action: "cancel", cancelImportOperationId: controlledOperation });
    cancelled = true;
    return route.fulfill({ json: latest });
  });
  await page.route(polling, (route) => route.fulfill({ json: {
    project: { ...latest, status: cancelled ? "cancelled" : "working" },
    operation: { id: controlledOperation, projectId: latest.id, sceneId: scene, targetAssetId: target.id,
      status: cancelled ? "cancelled" : "working", resultAssetId: null, error: null },
  } }));
  await page.reload();
  await selection(1, "cancelled.mp4", moving);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Import scene 1", exact: true }).click();
  await page.getByRole("button", { name: "Cancel production" }).click();
  await expect(announcement).toContainText("Import cancelled");
  await expect(page.getByText("Selected · cancelled.mp4")).toBeVisible();
  await other.close();
});

test("guides a Google Flow download through a local verified import", async ({ page }) => {
  test.setTimeout(80_000);
  await page.goto("/media-studio");
  await page.getByLabel("Topic", { exact: true }).fill("Manual Flow sample");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: "Manual Flow sample", exact: true })).toBeVisible();
  await page.getByText("Google Flow manual feasibility", { exact: true }).click();
  await expect(page.getByText("Status · manual required")).toBeVisible();
  await expect(page.getByText(/Gemini API fallback · disabled/)).toBeVisible();
  await page.getByRole("button", { name: "Start mock workflow" }).click();
  await page.getByRole("button", { name: "Approve script and storyboard" }).click();
  await expect(page.getByText("Status · ready for user action")).toBeVisible({ timeout: 35_000 });
  await page.getByRole("button", { name: "Approve final video" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^approved$/ })).toBeVisible();
  const approved = await page.getByLabel("Final MP4").getAttribute("src");
  await page.getByLabel("Check selected six-second clips as manual Google Flow downloads").check();
  await page.getByLabel("Import MP4 for scene 1").setInputFiles({
    name: "broken.mp4", mimeType: "video/mp4", buffer: Buffer.from("invalid mp4"),
  });
  await page.getByRole("button", { name: "Import scene 1", exact: true }).click();
  await expect(page.getByText("Status · failed")).toBeVisible();
  await expect(page.getByText("Selected · broken.mp4")).toBeVisible();
  const moving = execFileSync(process.env.FLOW_FFMPEG_BIN || "ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=90x160:rate=24",
    "-t", "6", "-c:v", "libx264", "-threads", "2", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1",
  ]);
  const response = page.waitForResponse((candidate) => candidate.request().method() === "POST"
    && new URL(candidate.url()).searchParams.get("source") === "google_flow");
  await page.getByLabel("Import MP4 for scene 1").setInputFiles({ name: "sample.mp4", mimeType: "video/mp4", buffer: moving });
  await page.getByRole("button", { name: "Import scene 1", exact: true }).click();
  expect((await (await response).json()).importOperationId).toMatch(/^[a-f0-9]{32}$/);
  await expect(page.getByText("Status · completed")).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Google Flow source selected by user · motion check passed")).toBeVisible();
  await expect(page.getByRole("link", { name: "Download last approved MP4" })).toHaveAttribute("href", `${approved}?download=true`);
  await expect(page.getByText("Audio · Studio mock tone · no spoken narration")).toBeVisible();
});
