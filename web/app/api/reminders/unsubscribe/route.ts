import { verifyReminderUnsubscribeToken } from "@/lib/server/reminder-token";
import {
  ensureReminderTables,
  isReminderEmailUnsubscribed,
  unsubscribeReminderEmail,
} from "@/lib/server/reminders-repo";

export const runtime = "nodejs";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlPage(input: {
  title: string;
  message: string;
  details?: string;
  status?: number;
}): Response {
  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${escapeHtml(input.title)}</title>
        <style>
          body {
            font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
            background: #f8fafc;
            color: #0f172a;
            margin: 0;
            padding: 24px;
          }
          .card {
            max-width: 560px;
            margin: 24px auto;
            background: #ffffff;
            border: 1px solid #e2e8f0;
            border-radius: 12px;
            padding: 20px;
            box-shadow: 0 8px 24px rgba(15, 23, 42, 0.06);
          }
          h1 {
            margin: 0 0 10px;
            font-size: 24px;
          }
          p {
            margin: 0 0 12px;
            line-height: 1.45;
          }
        </style>
      </head>
      <body>
        <main class="card">
          <h1>${escapeHtml(input.title)}</h1>
          <p>${escapeHtml(input.message)}</p>
          ${input.details ? `<p>${escapeHtml(input.details)}</p>` : ""}
          <p>You can close this tab.</p>
        </main>
      </body>
    </html>
  `;

  return new Response(html, {
    status: input.status ?? 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token")?.trim() ?? "";
  if (!token) {
    return htmlPage({
      status: 400,
      title: "Invalid unsubscribe link",
      message: "The unsubscribe link is missing or invalid.",
    });
  }

  const parsed = verifyReminderUnsubscribeToken(token);
  if (!parsed) {
    return htmlPage({
      status: 400,
      title: "Invalid or expired unsubscribe link",
      message: "Please use a recent reminder email link.",
    });
  }

  const ready = await ensureReminderTables();
  if (!ready) {
    return htmlPage({
      status: 500,
      title: "Database not configured",
      message: "We could not update your reminder preferences right now.",
      details: "Please try again later.",
    });
  }

  const alreadyUnsubscribed = await isReminderEmailUnsubscribed(parsed.email);
  if (alreadyUnsubscribed) {
    return htmlPage({
      title: "Already unsubscribed",
      message: `${parsed.email} is already unsubscribed from reminder emails.`,
    });
  }

  const saved = await unsubscribeReminderEmail(parsed.email, "email_link");
  if (!saved) {
    return htmlPage({
      status: 500,
      title: "Could not unsubscribe",
      message: "We could not save your unsubscribe request right now.",
    });
  }

  return htmlPage({
    title: "Unsubscribed",
    message: `${parsed.email} has been unsubscribed from reminder emails.`,
  });
}

export async function GET(request: Request) {
  return handleRequest(request);
}

