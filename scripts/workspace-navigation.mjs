// Existing behavioral suites navigate to the visible surface before interacting.
// Never force-click hidden controls: use the same navigation and tabs as a user.
export function workspacePage(page) {
  const go = async (path) => {
    const link = page.locator(
      `.primary-nav a:not(.shell-brand)[href="${path}${new URL(page.url()).search}"]`,
    );
    if (new URL(page.url()).pathname !== path) await link.click();
  };
  function wrap(locator) {
    const reveal = async () => {
      await locator.first().waitFor({ state: "attached" });
      const surface = await locator.first().evaluate((el) => ({
        bot: !!el.closest(".bot-panel"),
        market: !!el.closest(".watchlist"),
        terminal: !!el.closest(".chart-panel,.order-panel,.positions"),
        panel: el.closest(".order-panel")
          ? "Order"
          : el.closest(".positions")
            ? "Posisi"
            : "Chart",
        detail: !!el.closest(".connection-details"),
        balance: !!el.closest(".balance-details"),
      }));
      if (
        surface.balance &&
        !(
          (await page.locator(".balance-details").getAttribute("open")) !== null
        )
      )
        await page.locator(".balance-details summary").click();
      if (surface.bot) await go("/bot");
      else if (surface.market) await go("/markets");
      else if (surface.terminal) {
        await go("/");
        const tab = page
          .getByRole("navigation", { name: "Panel Terminal" })
          .getByRole("button", { name: surface.panel, exact: true });
        if (await tab.isVisible()) await tab.click();
      }
      if (
        surface.detail &&
        !(
          (await page.locator(".connection-details").getAttribute("open")) !==
          null
        )
      )
        await page.locator(".connection-details summary").click();
    };
    return new Proxy(locator, {
      get(target, key) {
        if (
          ["click", "fill", "selectOption", "waitFor", "innerText"].includes(
            key,
          )
        )
          return async (...args) => {
            if (
              key !== "waitFor" ||
              !args[0]?.state ||
              args[0].state === "visible"
            )
              await reveal();
            return target[key](...args);
          };
        if (
          [
            "first",
            "last",
            "nth",
            "filter",
            "locator",
            "getByRole",
            "getByText",
          ].includes(key)
        )
          return (...args) => {
            if (key === "getByRole")
              args[1] = { ...args[1], includeHidden: true };
            return wrap(target[key](...args));
          };
        return typeof target[key] === "function"
          ? target[key].bind(target)
          : target[key];
      },
    });
  }
  return new Proxy(page, {
    get(target, key) {
      if (["locator", "getByRole", "getByLabel", "getByText"].includes(key))
        return (...args) => {
          if (key === "getByRole")
            args[1] = { ...args[1], includeHidden: true };
          return wrap(target[key](...args));
        };
      return typeof target[key] === "function"
        ? target[key].bind(target)
        : target[key];
    },
  });
}
