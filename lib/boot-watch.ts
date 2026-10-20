// Client-side companion of the server's BOOT_ID: the first /api/agent/running
// response of a page load pins the serving instance; a different boot after
// that means the server restarted under this URL — the page must reload to
// pick up the new build. Dispatches SERVER_RESTARTED_EVENT once per swap.

export const SERVER_RESTARTED_EVENT = "pi-web:server-restarted";

export function noteServerBoot(boot: unknown, dispatch?: (event: Event) => void): void {
  if (typeof boot !== "string" || boot === "") return;
  const state = globalThis as { __piWebBoot?: string };
  const seen = state.__piWebBoot;
  if (seen === boot) return;
  const first = seen === undefined;
  state.__piWebBoot = boot;
  if (first) return;
  (dispatch ?? ((event) => globalThis.dispatchEvent?.(event)))(new Event(SERVER_RESTARTED_EVENT));
}
