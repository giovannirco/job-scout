import { toast } from "sonner";

/** Error text for a toast: the thrown message when there is one, otherwise the fallback. */
export function errorText(e: unknown, fallback = "Failed"): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/**
 * Adapt an async function for a DOM/event prop that expects a void callback.
 * A rejection is shown as an error toast instead of becoming an unhandled rejection;
 * handlers that already catch their own errors are unaffected.
 */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, fallback = "Failed"): (...args: A) => void {
  return (...args) => {
    fn(...args).catch((e: unknown) => {
      toast.error(errorText(e, fallback));
    });
  };
}
