import nodemailer from "nodemailer";

export type ReminderEmailInput = {
  to: string;
  subject: string;
  text: string;
};

export type ReminderEmailProvider =
  | "gmail_smtp"
  | "sendgrid_smtp"
  | "ses_smtp"
  | "smtp"
  | "log";

export type ReminderEmailResult = {
  sent: boolean;
  provider: ReminderEmailProvider;
  messageId: string | null;
  error: string | null;
};

type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  provider: Exclude<ReminderEmailProvider, "log">;
};

function sanitizeEmail(value: string): string {
  return value.trim();
}

function resolveProvider(): ReminderEmailProvider {
  const raw = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  switch (raw) {
    case "gmail":
    case "gmail_smtp":
      return "gmail_smtp";
    case "sendgrid":
    case "sendgrid_smtp":
      return "sendgrid_smtp";
    case "ses":
    case "ses_smtp":
      return "ses_smtp";
    case "smtp":
      return "smtp";
    case "log":
      return "log";
    default:
      return "smtp";
  }
}

function parsePort(value: string | undefined, fallbackPort: number): number {
  if (!value) return fallbackPort;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackPort;
  return parsed;
}

function parseSecure(value: string | undefined, fallbackSecure: boolean): boolean {
  if (!value) return fallbackSecure;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return fallbackSecure;
}

function resolveSmtpSettings(provider: ReminderEmailProvider): SmtpSettings | null {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();

  if (!user || !pass) return null;

  if (provider === "gmail_smtp") {
    return {
      provider,
      host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com",
      port: parsePort(process.env.SMTP_PORT?.trim(), 465),
      secure: parseSecure(process.env.SMTP_SECURE?.trim(), true),
      user,
      pass,
    };
  }

  if (provider === "sendgrid_smtp") {
    return {
      provider,
      host: process.env.SMTP_HOST?.trim() || "smtp.sendgrid.net",
      port: parsePort(process.env.SMTP_PORT?.trim(), 587),
      secure: parseSecure(process.env.SMTP_SECURE?.trim(), false),
      user,
      pass,
    };
  }

  if (provider === "ses_smtp") {
    const region = process.env.AWS_REGION?.trim();
    const defaultHost = region ? `email-smtp.${region}.amazonaws.com` : "";
    return {
      provider,
      host: process.env.SMTP_HOST?.trim() || defaultHost,
      port: parsePort(process.env.SMTP_PORT?.trim(), 587),
      secure: parseSecure(process.env.SMTP_SECURE?.trim(), false),
      user,
      pass,
    };
  }

  return {
    provider: "smtp",
    host: process.env.SMTP_HOST?.trim() || "",
    port: parsePort(process.env.SMTP_PORT?.trim(), 587),
    secure: parseSecure(process.env.SMTP_SECURE?.trim(), false),
    user,
    pass,
  };
}

function resolveFromEmail(): string {
  return (
    process.env.REMINDER_FROM_EMAIL?.trim() ||
    process.env.SMTP_FROM_EMAIL?.trim() ||
    ""
  );
}

export async function sendReminderEmail(
  input: ReminderEmailInput,
): Promise<ReminderEmailResult> {
  const to = sanitizeEmail(input.to);
  const from = resolveFromEmail();
  const provider = resolveProvider();

  if (!to || !from || provider === "log") {
    console.log("[ReminderEmail:log]", {
      provider,
      to,
      from,
      subject: input.subject,
      text: input.text,
    });
    return {
      sent: true,
      provider: "log",
      messageId: null,
      error: null,
    };
  }

  const smtp = resolveSmtpSettings(provider);
  if (!smtp || !smtp.host) {
    console.log("[ReminderEmail:log-missing-config]", {
      provider,
      to,
      from,
      subject: input.subject,
      hint:
        "Set EMAIL_PROVIDER, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, REMINDER_FROM_EMAIL.",
    });
    return {
      sent: true,
      provider: "log",
      messageId: null,
      error: null,
    };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: {
        user: smtp.user,
        pass: smtp.pass,
      },
    });

    const unsubscribeHeader = `<mailto:${from}?subject=unsubscribe>`;

    const result = await transporter.sendMail({
      from,
      to,
      subject: input.subject,
      text: input.text,
      headers: {
        "List-Unsubscribe": unsubscribeHeader,
      },
    });

    return {
      sent: true,
      provider: smtp.provider,
      messageId: result.messageId ?? null,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send SMTP email.";
    return {
      sent: false,
      provider: smtp.provider,
      messageId: null,
      error: message,
    };
  }
}
