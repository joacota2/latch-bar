import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test("keyboard dialogs contain focus, protect drafts, and restore focus", async ({
  page,
}) => {
  await page.goto("/");
  const card = page.getByRole("button", { name: /Improve writing/ }).first();
  await card.focus();
  await page.keyboard.press("Enter");
  const editor = page.getByRole("dialog", { name: "Edit agent" });
  await expect(editor).toBeVisible();
  await editor
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Unsaved draft");
  await page.keyboard.press("Escape");
  const prompt = page.getByRole("dialog", { name: "Unsaved changes" });
  await expect(prompt).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(prompt).toBeHidden();
  await expect(editor).toBeVisible();
  await page.keyboard.press("Escape");
  await prompt.getByRole("button", { name: "Discard" }).click();
  await expect(editor).toBeHidden();
  await expect(card).toBeFocused();
});
test("local fonts, reduced motion, and missing native compatibility APIs", async ({
  page,
}) => {
  const remote: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().startsWith("http") &&
      !request.url().startsWith("http://127.0.0.1")
    )
      remote.push(request.url());
  });
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(Object, "hasOwn", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(Array.prototype, "at", {
      value: undefined,
      configurable: true,
    });
    delete (HTMLElement.prototype as Partial<HTMLElement>).inert;
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Edit agent" })).toBeVisible();
  expect(await page.evaluate(() => "inert" in HTMLElement.prototype)).toBe(
    true,
  );
  expect(
    await page.evaluate(async () => {
      await document.fonts.ready;
      return (
        document.fonts.check('14px "DM Sans"') &&
        document.fonts.check('14px "Manrope"')
      );
    }),
  ).toBe(true);
  expect(remote).toEqual([]);
});
test("Studio and editor meet WCAG A/AA automated checks", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page
    .getByRole("button", { name: /Improve writing/ })
    .first()
    .click();
  await expect(page.getByRole("dialog", { name: "Edit agent" })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
});
