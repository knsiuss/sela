/** Deterministic non-network transport for local smoke tests and development. */

import type { OutboundMessage, TransportResponse } from "./types.js";
import type { WhatsAppTransport } from "./meta_transport.js";

/** In-memory transport that records validated messages for assertions. */
export class InMemoryTransport implements WhatsAppTransport {
  private readonly sent_messages: OutboundMessage[] = [];
  private next_wamid_number = 1;

  /**
   * Submit a message without network I/O.
   *
   * @param message - Sender-validated outbound message.
   * @returns A deterministic outbound WAMID.
   */
  async send(message: OutboundMessage): Promise<TransportResponse> {
    this.sent_messages.push(clone_message(message));
    return {
      wamid: `wamid.inmemory.${this.next_wamid_number++}`,
      status: "sent",
    };
  }

  /**
   * Return defensive copies of messages accepted by this transport.
   *
   * @returns Snapshot in submission order.
   */
  messages(): OutboundMessage[] {
    return this.sent_messages.map(clone_message);
  }
}

function clone_message(message: OutboundMessage): OutboundMessage {
  return {
    ...message,
    ...(message.text === undefined ? {} : { text: { ...message.text } }),
    ...(message.template === undefined
      ? {}
      : {
          template: {
            ...message.template,
            ...(message.template.components === undefined
              ? {}
              : { components: message.template.components.map((component) => ({ ...component })) }),
          },
        }),
    ...(message.buttons === undefined ? {} : { buttons: message.buttons.map((button) => ({ ...button })) }),
    ...(message.interactive === undefined
      ? {}
      : {
          interactive: {
            ...message.interactive,
            body: { ...message.interactive.body },
            action: { buttons: message.interactive.action.buttons.map((button) => ({ ...button })) },
          },
        }),
  };
}
