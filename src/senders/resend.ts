import type { OutboundMessage, SendResult, Sender } from "./index";

/**
 * Resend adapter. Free tier: 3,000/month, 100/day, one domain — comfortably
 * more than personal correspondence needs.
 *
 * Threading headers are set here rather than left to the caller because
 * omitting them is invisible locally and only shows up as an orphaned thread
 * in the recipient's client, where you'll never see it.
 */
export function resendSender(apiKey: string): Sender {
  return {
    name: "resend",

    async send(message: OutboundMessage): Promise<SendResult> {
      const headers: Record<string, string> = { ...(message.headers ?? {}) };
      if (message.inReplyTo) headers["In-Reply-To"] = message.inReplyTo;
      if (message.references) headers["References"] = message.references;

      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          bcc: message.bcc,
          reply_to: message.replyTo,
          attachments: message.attachments,
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: Object.keys(headers).length ? headers : undefined,
        }),
      });

      const body = (await response.json()) as { id?: string; message?: string };
      if (!response.ok) {
        throw new Error(`Resend rejected the message (${response.status}): ${body.message ?? "unknown"}`);
      }
      return { messageId: body.id ?? "" };
    },
  };
}
