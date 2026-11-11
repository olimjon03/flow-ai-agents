import { expect, test } from "@playwright/test";

test("the 3D office receives real simulated task events and reconnects to the latest snapshot", async ({ page, request }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/ai-office");
  const start = page.getByRole("button", { name: "Start demo task" });
  const detail = page.getByRole("region", { name: "Agent details" });
  await expect(page.getByText("Live backend · Simulated agents")).toBeVisible();
  await expect(page.getByRole("button", { name: "Scout workstation", exact: true })).toHaveAccessibleDescription("Status: idle");
  await expect(detail.getByText("No task assigned")).toBeVisible();

  await start.click();
  await expect(start).toBeDisabled();
  await expect(page.getByText("Demo workflow running")).toBeVisible();
  await expect(detail.getByText("Scan content trends", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scout workstation", exact: true })).toHaveAccessibleDescription("Status: working");
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
  const stations = page.getByRole("region", { name: "Workstations" }).getByRole("button", { name: /workstation$/ });
  await expect(stations).toHaveCount(12);
  for (const station of await stations.all()) {
    await expect(station).toHaveAccessibleDescription("Status: completed");
  }
  const timeline = page.getByRole("region", { name: "Activity timeline" });
  await expect(timeline.getByText("Completed: Prepare release checklist")).toBeVisible();
  const usage = page.getByRole("region", { name: "API usage" });
  await expect(usage.getByText("$0.000", { exact: true })).toBeVisible();
});

test("submits a mock agent brief and displays the script and review from SSE", async ({ page }) => {
  const network = await page.context().newCDPSession(page);
  const topic = "Urban gardens";
  const runningMockIds = new Set<string>();
  const completedMockIds = new Set<string>();
  await network.send("Network.enable");
  network.on("Network.eventSourceMessageReceived", ({ eventName, data }) => {
    if (eventName !== "office.snapshot") return;
    const { run, agents } = JSON.parse(data);
    if (run?.mode !== "mock" || !agents.some((agent: { task: string | null }) => agent.task === `Research: ${topic}`)) return;
    if (run.status === "running") runningMockIds.add(run.id);
    if (run.status === "completed") completedMockIds.add(run.id);
  });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/ai-office");
  await expect(page.getByText("Live backend · Simulated agents")).toBeVisible();
  await page.getByText("Agent workflow", { exact: true }).click();
  await page.getByLabel("Topic").fill(topic);
  await page.getByLabel("Language").fill("English");
  await page.getByLabel("Content style").fill("Friendly");
  await page.getByLabel("Target duration (seconds)").fill("75");
  const submission = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/office/tasks" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Run in mock mode" }).click();
  expect((await submission).status()).toBe(202);
  // A fast run may finish before Playwright can sample its transient UI state.
  await expect(page.getByText("Mock workflow completed")).toBeVisible({ timeout: 12_000 });
  await expect.poll(() => [...completedMockIds].some((id) => runningMockIds.has(id))).toBe(true);
  await expect(page.getByRole("region", { name: "Activity timeline" }).getByText("Reviewer started", { exact: true })).toBeVisible();
  const results = page.getByRole("region", { name: "Mock results" });
  await expect(results.getByText(/Urban gardens · English · Friendly · 75s/)).toBeVisible();
  await expect(results.getByText(/Mock review/)).toBeVisible();
  await expect(page.getByRole("region", { name: "API usage" }).getByText("$0.000", { exact: true })).toBeVisible();
});

test("animates backend handoffs once and clears movement when the run is cancelled", async ({ page }) => {
  test.setTimeout(35_000);
  await page.setViewportSize({ width: 1536, height: 900 });
  await page.goto("/ai-office");
  await expect(page.getByText("Live backend · Simulated agents")).toBeVisible();
  const workstations = page.getByRole("region", { name: "Workstations" });
  const enable3D = workstations.getByRole("button", { name: "Switch to 3D" });
  if (await enable3D.isVisible()) await enable3D.click();
  const canvas = workstations.getByLabel("3D office view. Use arrow keys to pan.", { exact: true });
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  const nova = workstations.getByRole("button", { name: "Nova workstation", exact: true });
  const muse = workstations.getByRole("button", { name: "Muse workstation", exact: true });
  await expect(nova).toHaveAttribute("data-motion", "idle");
  await expect(muse).toHaveAttribute("data-motion", "idle");
  await page.getByRole("button", { name: "Start demo task" }).click();
  await expect(nova).toHaveAttribute("data-motion", "walking", { timeout: 10_000 });
  await expect(muse).toHaveAttribute("data-motion", "receiving_task", { timeout: 10_000 });
  await expect(nova).toHaveAttribute("data-motion", "returning_to_desk", { timeout: 7_000 });
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByText("Demo workflow cancelled")).toBeVisible();
  await expect(nova).not.toHaveAttribute("data-motion", /walking|handing_over_task|returning_to_desk/);

  await page.reload();
  await expect(page.getByText("Demo workflow cancelled")).toBeVisible();
  if (await enable3D.isVisible()) await enable3D.click();
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await expect(nova).toHaveAttribute("data-motion", "idle");
});
