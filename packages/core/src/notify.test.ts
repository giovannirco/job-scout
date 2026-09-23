import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";

const dataDir = path.join(process.cwd(), ".data", "pglite-notify-test");

describe("flushNotify", () => {
  beforeAll(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.env.PGLITE_DATA_DIR = dataDir;
    delete process.env.DATABASE_URL;
    const { bootstrap } = await import("./bootstrap.js");
    await bootstrap({ seedBoards: false });
  });

  afterAll(async () => {
    const { resetWahaSender } = await import("./waha.js");
    resetWahaSender();
    const { closeDb } = await import("@job-scout/db");
    await closeDb();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("sends a pending outbox row once when API flush races the worker", async () => {
    const { getDb, notificationOutbox } = await import("@job-scout/db");
    const { flushNotify, flushDueNotifications } = await import("./notify.js");
    const { setWahaSender } = await import("./waha.js");

    const sent: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    setWahaSender({
      configured: true,
      session: "default",
      async sendText(_chatId, body) {
        sent.push(body);
        await hold;
        return { ok: true, providerRef: `ref-${sent.length}` };
      },
      async listMessages() {
        return [];
      },
    });

    const db = await getDb();
    const rowId = "ntf_race_1";
    await db.insert(notificationOutbox).values({
      id: rowId,
      channel: "desk",
      event: "test",
      chatId: "111111000000000001@g.us",
      body: "job-scout test · desk · race",
      status: "pending",
    });

    const racing = Promise.all([flushNotify(rowId), flushNotify(rowId), flushDueNotifications()]);
    await new Promise((r) => setTimeout(r, 40));
    release();
    await racing;

    expect(sent).toEqual(["job-scout test · desk · race"]);
    const row = (await db.select().from(notificationOutbox).where(eq(notificationOutbox.id, rowId)))[0];
    expect(row?.status).toBe("sent");
  });
});
