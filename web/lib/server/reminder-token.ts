import crypto from "node:crypto";

export type ReminderAction = "done" | "not_yet" | "reschedule";

type ActionTokenPayload = {
  meetingId: string;
  promiseIndex: number;
  action: ReminderAction;
  exp: number;
};

type UnsubscribeTokenPayload = {
  email: string;
  exp: number;
};

type InboxTokenPayload = {
  email: string;
  exp: number;
};

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;
const FALLBACK_SECRET = "meeting-memory-dev-reminder-secret-change-me";

function toBase64Url(input: Buffer | string): string {
  const value = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function getSecret(): string {
  return (
    process.env.REMINDER_SIGNING_SECRET?.trim() ||
    process.env.NEXTAUTH_SECRET?.trim() ||
    FALLBACK_SECRET
  );
}

function sign(payloadBase64: string): string {
  return toBase64Url(
    crypto.createHmac("sha256", getSecret()).update(payloadBase64).digest(),
  );
}

function verifySignedPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadBase64, signature] = parts;
  if (!payloadBase64 || !signature) return null;

  const expected = sign(payloadBase64);
  const sigBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (sigBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;

  try {
    const parsed = JSON.parse(fromBase64Url(payloadBase64).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createReminderActionToken(input: {
  meetingId: string;
  promiseIndex: number;
  action: ReminderAction;
  ttlSeconds?: number;
}): string {
  const payload: ActionTokenPayload = {
    meetingId: input.meetingId,
    promiseIndex: input.promiseIndex,
    action: input.action,
    exp: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };

  const payloadBase64 = toBase64Url(JSON.stringify(payload));
  const signature = sign(payloadBase64);
  return `${payloadBase64}.${signature}`;
}

export function verifyReminderActionToken(token: string): ActionTokenPayload | null {
  const parsed = verifySignedPayload(token);
  if (!parsed) return null;

  const meetingId = parsed.meetingId;
  const promiseIndex = parsed.promiseIndex;
  const action = parsed.action;
  const exp = parsed.exp;

  if (typeof meetingId !== "string") return null;
  if (typeof promiseIndex !== "number" || !Number.isInteger(promiseIndex) || promiseIndex < 0) {
    return null;
  }
  if (action !== "done" && action !== "not_yet" && action !== "reschedule") return null;
  if (typeof exp !== "number" || !Number.isInteger(exp)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;

  return {
    meetingId,
    promiseIndex,
    action,
    exp,
  };
}

export function createReminderUnsubscribeToken(input: {
  email: string;
  ttlSeconds?: number;
}): string {
  const payload: UnsubscribeTokenPayload = {
    email: input.email.trim().toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };

  const payloadBase64 = toBase64Url(JSON.stringify(payload));
  const signature = sign(payloadBase64);
  return `${payloadBase64}.${signature}`;
}

export function verifyReminderUnsubscribeToken(
  token: string,
): UnsubscribeTokenPayload | null {
  const parsed = verifySignedPayload(token);
  if (!parsed) return null;

  const emailValue = parsed.email;
  const exp = parsed.exp;
  if (typeof emailValue !== "string") return null;
  if (typeof exp !== "number" || !Number.isInteger(exp)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;

  const email = emailValue.trim().toLowerCase();
  if (!email) return null;

  return {
    email,
    exp,
  };
}

export function createMeetingInboxToken(input: {
  email: string;
  ttlSeconds?: number;
}): string {
  const payload: InboxTokenPayload = {
    email: input.email.trim().toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };

  const payloadBase64 = toBase64Url(JSON.stringify(payload));
  const signature = sign(payloadBase64);
  return `${payloadBase64}.${signature}`;
}

export function verifyMeetingInboxToken(token: string): InboxTokenPayload | null {
  const parsed = verifySignedPayload(token);
  if (!parsed) return null;

  const emailValue = parsed.email;
  const exp = parsed.exp;
  if (typeof emailValue !== "string") return null;
  if (typeof exp !== "number" || !Number.isInteger(exp)) return null;
  if (exp < Math.floor(Date.now() / 1000)) return null;

  const email = emailValue.trim().toLowerCase();
  if (!email) return null;

  return {
    email,
    exp,
  };
}
