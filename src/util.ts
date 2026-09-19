export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(f: () => Promise<T>, what: string, tries = 90): Promise<T> {
  for (let i = 0; i < tries; i++) {
    try {
      return await f();
    } catch {
      await sleep(1000);
    }
  }
  throw new Error(`timeout waiting for ${what}`);
}
