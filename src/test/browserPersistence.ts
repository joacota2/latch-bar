import type * as Persistence from "../services/persistence";
export async function browserPersistence(
  original: () => Promise<typeof Persistence>,
) {
  const actual = await original();
  return {
    ...actual,
    readState: async () => actual.browserSnapshot(),
    changeState: actual.changeBrowserState,
  };
}
