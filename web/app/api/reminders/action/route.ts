import { runQuery } from "@/lib/server/db";
import { verifyReminderActionToken } from "@/lib/server/reminder-token";
import {
  ensureReminderTables,
  getPromiseStateMap,
  markPromiseDone,
  markPromiseNotYet,
  reschedulePromise,
} from "@/lib/server/reminders-repo";
import {
  addDays,
  normalizePromises,
  parseIsoDate,
  toIsoDate,
  type NormalizedPromise,
} from "@/lib/server/promise-utils";

export const runtime = "nodejs";

type VerifiedToken = NonNullable<ReturnType<typeof verifyReminderActionToken>>;

type MeetingPromiseRow = {
  meeting_id: string;
  promises_list: unknown;
};

type RequestFields = {
  token: string | null;
  date: string | null;
};

type ReminderContext = {
  rawToken: string;
  token: VerifiedToken;
  item: NormalizedPromise;
  effectiveDueIso: string | null;
};

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function personLabel(person: string): string {
  return person === "Speaker" ? "You" : person;
}

function promiseLabel(item: NormalizedPromise): string {
  const person = personLabel(item.person);
  const deadlinePart = item.deadline ? ` by ${item.deadline}` : "";
  return `${person}: ${item.task}${deadlinePart}`;
}

function toIsoDateOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return toIsoDate(parsed);
}

function suggestedRescheduleDate(currentDueIso: string | null): string {
  const base = currentDueIso ? parseIsoDate(currentDueIso) : null;
  return toIsoDate(addDays(base ?? new Date(), 3));
}

function htmlPage(input: {
  title: string;
  message: string;
  details?: string;
  status?: number;
  extraHtml?: string;
}): Response {
  const title = escapeHtml(input.title);
  const message = escapeHtml(input.message);
  const details = input.details ? `<p>${escapeHtml(input.details)}</p>` : "";
  const extraHtml = input.extraHtml ?? "";
  const html = `
    <!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
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
          .muted {
            color: #475569;
            font-size: 14px;
          }
          .btn {
            display: inline-block;
            margin-top: 12px;
            padding: 10px 14px;
            border-radius: 8px;
            background: #0f172a;
            color: #ffffff;
            text-decoration: none;
            border: 0;
            cursor: pointer;
            font-size: 14px;
          }
          label {
            display: block;
            font-size: 14px;
            margin: 8px 0 6px;
          }
          input[type="date"] {
            width: 100%;
            max-width: 260px;
            padding: 8px 10px;
            border: 1px solid #cbd5e1;
            border-radius: 8px;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <main class="card">
          <h1>${title}</h1>
          <p>${message}</p>
          ${details}
          ${extraHtml}
          <p class="muted">You can close this tab.</p>
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

function renderInvalidLink(): Response {
  return htmlPage({
    status: 400,
    title: "Invalid or expired link",
    message: "This reminder action link is no longer valid.",
    details: "Please open the latest reminder email and try again.",
  });
}

async function parseRequestFields(request: Request, url: URL): Promise<RequestFields> {
  let token = url.searchParams.get("token");
  let date = url.searchParams.get("date");

  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await request.json().catch(() => null)) as
        | { token?: unknown; date?: unknown }
        | null;
      if (typeof body?.token === "string") token = body.token;
      if (typeof body?.date === "string") date = body.date;
    } else {
      const formData = await request.formData().catch(() => null);
      const tokenValue = formData?.get("token");
      const dateValue = formData?.get("date");
      if (typeof tokenValue === "string") token = tokenValue;
      if (typeof dateValue === "string") date = dateValue;
    }
  }

  return {
    token: token?.trim() || null,
    date: date?.trim() || null,
  };
}

async function loadReminderContext(
  rawToken: string,
  token: VerifiedToken,
): Promise<ReminderContext | Response> {
  const dbReady = await ensureReminderTables();
  if (!dbReady) {
    return htmlPage({
      status: 500,
      title: "Database not configured",
      message: "Reminder action could not be saved.",
      details: "Set DATABASE_URL and try again.",
    });
  }

  const meetingResult = await runQuery<MeetingPromiseRow>(
    `
      select
        meeting_id::text,
        promises_list
      from meetings
      where meeting_id = $1
      limit 1
    `,
    [token.meetingId],
  );

  if (meetingResult.skipped) {
    return htmlPage({
      status: 500,
      title: "Database not configured",
      message: "Reminder action could not be saved.",
      details: "Set DATABASE_URL and try again.",
    });
  }

  const row = meetingResult.rows[0];
  if (!row) {
    return htmlPage({
      status: 404,
      title: "Meeting not found",
      message: "This reminder link points to a meeting we cannot find.",
    });
  }

  const promises = normalizePromises(row.promises_list);
  const item = promises[token.promiseIndex];
  if (!item) {
    return htmlPage({
      status: 400,
      title: "Invalid reminder item",
      message: "This reminder link refers to a task that does not exist.",
    });
  }

  const stateResult = await getPromiseStateMap(token.meetingId);
  const state = stateResult.map.get(token.promiseIndex);
  const effectiveDueIso =
    toIsoDateOrNull(state?.rescheduled_to) ?? toIsoDateOrNull(item.actual_date);

  return {
    rawToken,
    token,
    item,
    effectiveDueIso,
  };
}

function renderRescheduleForm(context: ReminderContext): Response {
  const todayIso = toIsoDate(new Date());
  const suggestedIso = suggestedRescheduleDate(context.effectiveDueIso);
  const taskLabel = promiseLabel(context.item);
  const details = context.effectiveDueIso
    ? `Current due date: ${context.effectiveDueIso}`
    : "No due date set yet.";

  const extraHtml = `
    <p><strong>${escapeHtml(taskLabel)}</strong></p>
    <p>${escapeHtml(details)}</p>
    <form method="post" action="/api/reminders/action">
      <input type="hidden" name="token" value="${escapeHtml(context.rawToken)}" />
      <label for="date">New due date</label>
      <input
        id="date"
        name="date"
        type="date"
        min="${escapeHtml(todayIso)}"
        value="${escapeHtml(suggestedIso)}"
        required
      />
      <br />
      <button class="btn" type="submit">Save new date</button>
    </form>
  `;

  return htmlPage({
    title: "Reschedule task",
    message: "Pick a new due date for this task.",
    extraHtml,
  });
}

async function applyReminderAction(
  context: ReminderContext,
  requestedDate: string | null,
): Promise<Response> {
  const taskLabel = promiseLabel(context.item);

  if (context.token.action === "done") {
    const saved = await markPromiseDone(context.token.meetingId, context.token.promiseIndex, true);
    if (!saved) {
      return htmlPage({
        status: 500,
        title: "Could not save",
        message: "We could not mark this task as done.",
      });
    }
    return htmlPage({
      title: "Marked as done",
      message: taskLabel,
    });
  }

  if (context.token.action === "not_yet") {
    const saved = await markPromiseNotYet(context.token.meetingId, context.token.promiseIndex);
    if (!saved) {
      return htmlPage({
        status: 500,
        title: "Could not save",
        message: "We could not save your status update.",
      });
    }
    return htmlPage({
      title: "Saved as not done yet",
      message: taskLabel,
    });
  }

  if (!requestedDate) {
    return renderRescheduleForm(context);
  }

  const parsedDate = parseIsoDate(requestedDate);
  if (!parsedDate) {
    return htmlPage({
      status: 400,
      title: "Invalid date",
      message: "Use a valid date in YYYY-MM-DD format.",
    });
  }

  const todayIso = toIsoDate(new Date());
  const newDueIso = toIsoDate(parsedDate);
  if (newDueIso < todayIso) {
    return htmlPage({
      status: 400,
      title: "Date is in the past",
      message: "Pick today or a future date.",
    });
  }

  const saved = await reschedulePromise(
    context.token.meetingId,
    context.token.promiseIndex,
    newDueIso,
  );
  if (!saved) {
    return htmlPage({
      status: 500,
      title: "Could not save",
      message: "We could not reschedule this task right now.",
    });
  }

  return htmlPage({
    title: "Task rescheduled",
    message: taskLabel,
    details: `New due date: ${newDueIso}`,
  });
}

async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const fields = await parseRequestFields(request, url);
  if (!fields.token) {
    return renderInvalidLink();
  }

  const verified = verifyReminderActionToken(fields.token);
  if (!verified) {
    return renderInvalidLink();
  }

  const contextOrResponse = await loadReminderContext(fields.token, verified);
  if (contextOrResponse instanceof Response) {
    return contextOrResponse;
  }

  return applyReminderAction(contextOrResponse, fields.date);
}

export async function GET(request: Request) {
  return handleRequest(request);
}

export async function POST(request: Request) {
  return handleRequest(request);
}
