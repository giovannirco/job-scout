import { beforeEach, describe, expect, it, vi } from "vitest";

const error = vi.fn();
vi.mock("sonner", () => ({ toast: { error } }));

const { errorText, handle } = await import("./async.js");

describe("async event handlers", () => {
  beforeEach(() => error.mockClear());

  it("passes arguments through and stays quiet on success", async () => {
    const fn = vi.fn(async (a: number, b: string) => `${a}${b}`);
    handle(fn)(1, "x");
    await Promise.resolve();
    expect(fn).toHaveBeenCalledWith(1, "x");
    expect(error).not.toHaveBeenCalled();
  });

  it("returns nothing, so it fits void event props", () => {
    expect(handle(async () => 1)()).toBeUndefined();
  });

  it("toasts the rejection message", async () => {
    handle(async () => { throw new Error("boom"); })();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("boom"));
  });

  it("falls back when the rejection carries no message", async () => {
    handle(() => Promise.reject("nope"), "Could not save")();
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith("Could not save"));
    expect(errorText(new Error(""), "x")).toBe("x");
  });
});
