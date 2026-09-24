import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "../src/in_memory_transport.js";

describe("InMemoryTransport", () => {
  it("returns deterministic ids and defensive message snapshots", async () => {
    const transport = new InMemoryTransport();
    const message = {
      to: "+15551234567",
      type: "text" as const,
      text: { body: "hello" },
      idempotency_key: "test-key",
    };

    await expect(transport.send(message)).resolves.toMatchObject({
      wamid: "wamid.inmemory.1",
      status: "sent",
    });
    message.text.body = "changed";
    expect(transport.messages()[0]?.text?.body).toBe("hello");

    await expect(transport.send(message)).resolves.toMatchObject({
      wamid: "wamid.inmemory.2",
    });
  });
});
