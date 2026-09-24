import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "./client.js";

const context = new AsyncLocalStorage<Db>();
export const currentDb = () => context.getStore();
/** Keep legacy repair helpers on the same transaction and connection. */
export const withDbContext = <T>(db: Db, run: () => Promise<T>): Promise<T> => context.run(db, run);
