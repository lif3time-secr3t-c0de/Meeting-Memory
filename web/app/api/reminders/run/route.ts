import { NextResponse } from "next/server";
import { sendReminderEmail } from "@/lib/server/email";
import {
  createReminderActionToken,
  createMeetingInboxToken,
  createReminderUnsubscribeToken,
  type ReminderAction,
} from "@/lib/server/reminder-token";
import {
  ensureReminderTables,
  getMeetingsForReminders,
  getPromiseStateMap,
  hasReminderEvent,
  recordReminderEvent,
  type ReminderType,
} from "@/lib/server/reminders-repo";
import {
  addDays,
  normalizePromises,
  parseAnyDateToIso,
  parseIsoDate,
  toIsoDate,
  type NormalizedPromise,
} from "@/lib/server/promise-utils";

export const runtime = "nodejs";
export const maxDuration = 300;

type ReminderCandidate = {
  index: number;
  item: NormalizedPromise;
  done: boolean;
  effectiveDueDate: string | null;
};

function resolveBaseUrl(request: Request): string {
  const explicit = process.env.APP_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const proto =
    request.headers.get("x-forwarded-proto") ||
    (request.url.startsWith("https://") ? "https" : "http");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (!host) return "http://localhost:3000";
  return `${proto}://${host}`;
}

function buildActionUrl(
  baseUrl: string,
  meetingId: string,
  promiseIndex: number,
  action: ReminderAction,
): string {
  const token = createReminderActionToken({
    meetingId,
    promiseIndex,
    action,
  });
  return `${baseUrl}/api/reminders/action?token=${encodeURIComponent(token)}`;
}

function buildUnsubscribeUrl(baseUrl: string, email: string): string {
  const token = createReminderUnsubscribeToken({ email });
  return `${baseUrl}/api/reminders/unsubscribe?token=${encodeURIComponent(token)}`;
}

function buildMeetingsInboxUrl(baseUrl: string, email: string): string {
  const token = createMeetingInboxToken({ email });
  return `${baseUrl}/?inbox=${encodeURIComponent(token)}`;
}

function labelForPerson(person: string): string {
  if (person === "Speaker") return "You";
  return person;
}

function formatPromiseLine(item: NormalizedPromise): string {
  const person = labelForPerson(item.person);
  const deadlinePart = item.deadline ? ` by ${item.deadline}` : "";
  return `${person}: ${item.task}${deadlinePart}`;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseDateInput(value: unknown): string {
  if (typeof value !== "string") return toIsoDate(new Date());
  const parsed = parseIsoDate(value);
  if (!parsed) return toIsoDate(new Date());
  return toIsoDate(parsed);
}

function isAuthorized(request: Request): boolean {
  const expected = process.env.REMINDERS_CRON_SECRET?.trim();
  if (!expected) return true;

  const headerValue = request.headers.get("x-reminders-secret")?.trim();
  if (headerValue && headerValue === expected) return true;

  const authHeader = request.headers.get("authorization")?.trim() ?? "";
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice("bearer ".length).trim();
    if (token === expected) return true;
  }

  return false;
}

function buildNextDayReminderEmail(input: {
  meetingId: string;
  candidates: ReminderCandidate[];
  baseUrl: string;
  unsubscribeUrl: string;
  meetingsUrl: string;
}): { subject: string; text: string } {
  const linesText = input.candidates
    .map((candidate) => {
      const doneUrl = buildActionUrl(input.baseUrl, input.meetingId, candidate.index, "done");
      const notYetUrl = buildActionUrl(
        input.baseUrl,
        input.meetingId,
        candidate.index,
        "not_yet",
      );
      return [
        `[ ] ${formatPromiseLine(candidate.item)}`,
        `  YES, DONE: ${doneUrl}`,
        `  NOT YET: ${notYetUrl}`,
      ].join("\n");
    })
    .join("\n\n");

  return {
    subject: "What you promised yesterday",
    text: [
      "Hi,",
      "In yesterday's meeting you said:",
      "",
      linesText,
      "",
      "Reply by clicking one link above each task.",
      `View all meetings: ${input.meetingsUrl}`,
      "",
      `Unsubscribe: ${input.unsubscribeUrl}`,
    ].join("\n"),
  };
}

function buildDueTomorrowEmail(input: {
  index: number;
  item: NormalizedPromise;
  baseUrl: string;
  meetingId: string;
  unsubscribeUrl: string;
  meetingsUrl: string;
}): { subject: string; text: string } {
  const doneUrl = buildActionUrl(input.baseUrl, input.meetingId, input.index, "done");
  const notYetUrl = buildActionUrl(input.baseUrl, input.meetingId, input.index, "not_yet");
  const taskLine = formatPromiseLine(input.item);

  return {
    subject: "Reminder: Task due tomorrow",
    text: [
      `Your task "${taskLine}" is due tomorrow.`,
      "",
      `YES, DONE: ${doneUrl}`,
      `NOT YET: ${notYetUrl}`,
      "",
      `View all meetings: ${input.meetingsUrl}`,
      "",
      `Unsubscribe: ${input.unsubscribeUrl}`,
    ].join("\n"),
  };
}

function buildOverdueEmail(input: {
  index: number;
  item: NormalizedPromise;
  baseUrl: string;
  meetingId: string;
  unsubscribeUrl: string;
  meetingsUrl: string;
}): { subject: string; text: string } {
  const doneUrl = buildActionUrl(input.baseUrl, input.meetingId, input.index, "done");
  const rescheduleUrl = buildActionUrl(
    input.baseUrl,
    input.meetingId,
    input.index,
    "reschedule",
  );
  const taskLine = formatPromiseLine(input.item);

  return {
    subject: "Overdue task",
    text: [
      `Your task "${taskLine}" was due yesterday.`,
      "",
      `YES, DONE: ${doneUrl}`,
      `RESCHEDULE: ${rescheduleUrl}`,
      "",
      `View all meetings: ${input.meetingsUrl}`,
      "",
      `Unsubscribe: ${input.unsubscribeUrl}`,
    ].join("\n"),
  };
}

async function runReminderJob(request: Request, options: {
  targetDateIso: string;
  dryRun: boolean;
}) {
  const baseUrl = resolveBaseUrl(request);
  const reminderTablesReady = await ensureReminderTables();
  if (!reminderTablesReady) {
    return NextResponse.json(
      {
        error:
          "Database is not configured. Set DATABASE_URL before running reminders.",
      },
      { status: 500 },
    );
  }

  const meetingsResult = await getMeetingsForReminders();
  if (meetingsResult.skipped) {
    return NextResponse.json(
      {
        error:
          "Database is not configured. Set DATABASE_URL before running reminders.",
      },
      { status: 500 },
    );
  }

  let meetingsScanned = 0;
  let emailsAttempted = 0;
  let emailsSent = 0;
  let emailsSkipped = 0;
  const errors: string[] = [];

  for (const meeting of meetingsResult.rows) {
    meetingsScanned += 1;
    const promises = normalizePromises(meeting.promises_list);
    if (promises.length === 0) continue;

    const stateResult = await getPromiseStateMap(meeting.meeting_id);
    const stateMap = stateResult.map;
    const meetingDateIso = parseAnyDateToIso(meeting.date);
    const meetingDate = parseIsoDate(meetingDateIso);
    if (!meetingDate) continue;

    const candidates: ReminderCandidate[] = promises.map((item, index) => {
      const state = stateMap.get(index);
      const done = Boolean(state?.done || item.done);
      const effectiveDueDate = state?.rescheduled_to
        ? parseAnyDateToIso(state.rescheduled_to)
        : item.actual_date;
      return {
        index,
        item,
        done,
        effectiveDueDate,
      };
    });
    const unsubscribeUrl = buildUnsubscribeUrl(baseUrl, meeting.user_email);
    const meetingsUrl = buildMeetingsInboxUrl(baseUrl, meeting.user_email);

    const nextDayIso = toIsoDate(addDays(meetingDate, 1));
    if (options.targetDateIso === nextDayIso) {
      const openCandidates = candidates.filter((candidate) => !candidate.done);
      if (openCandidates.length > 0) {
        const alreadySent = await hasReminderEvent(
          meeting.meeting_id,
          -1,
          "next_day_summary",
          options.targetDateIso,
        );
        if (!alreadySent) {
          const content = buildNextDayReminderEmail({
            baseUrl,
            meetingId: meeting.meeting_id,
            candidates: openCandidates,
            unsubscribeUrl,
            meetingsUrl,
          });

          emailsAttempted += 1;
          let sentNow = false;
          if (options.dryRun) {
            sentNow = true;
            emailsSent += 1;
          } else {
            const result = await sendReminderEmail({
              to: meeting.user_email,
              subject: content.subject,
              text: content.text,
            });
            if (!result.sent) {
              emailsSkipped += 1;
              errors.push(
                `next_day_summary failed for meeting ${meeting.meeting_id}: ${result.error}`,
              );
            } else {
              sentNow = true;
              emailsSent += 1;
            }
          }

          if (sentNow) {
            await recordReminderEvent({
              meetingId: meeting.meeting_id,
              promiseIndex: -1,
              reminderType: "next_day_summary",
              scheduledFor: options.targetDateIso,
              email: meeting.user_email,
              subject: content.subject,
              meta: { promise_count: openCandidates.length },
            });
          }
        }
      }
    }

    for (const candidate of candidates) {
      if (candidate.done) continue;
      if (!candidate.effectiveDueDate) continue;

      const dueDate = parseIsoDate(candidate.effectiveDueDate);
      if (!dueDate) continue;

      const dayBeforeIso = toIsoDate(addDays(dueDate, -1));
      const dayAfterIso = toIsoDate(addDays(dueDate, 1));

      const reminderConfigs: Array<{
        shouldSend: boolean;
        reminderType: ReminderType;
        build: () => { subject: string; text: string };
      }> = [
        {
          shouldSend: options.targetDateIso === dayBeforeIso,
          reminderType: "due_tomorrow",
          build: () =>
            buildDueTomorrowEmail({
              baseUrl,
              meetingId: meeting.meeting_id,
              index: candidate.index,
              item: candidate.item,
              unsubscribeUrl,
              meetingsUrl,
            }),
        },
        {
          shouldSend: options.targetDateIso === dayAfterIso,
          reminderType: "overdue",
          build: () =>
            buildOverdueEmail({
              baseUrl,
              meetingId: meeting.meeting_id,
              index: candidate.index,
              item: candidate.item,
              unsubscribeUrl,
              meetingsUrl,
            }),
        },
      ];

      for (const reminderConfig of reminderConfigs) {
        if (!reminderConfig.shouldSend) continue;
        const alreadySent = await hasReminderEvent(
          meeting.meeting_id,
          candidate.index,
          reminderConfig.reminderType,
          options.targetDateIso,
        );
        if (alreadySent) continue;

        const content = reminderConfig.build();
        emailsAttempted += 1;

        let sentNow = false;
        if (options.dryRun) {
          sentNow = true;
          emailsSent += 1;
        } else {
          const result = await sendReminderEmail({
            to: meeting.user_email,
            subject: content.subject,
            text: content.text,
          });
          if (!result.sent) {
            emailsSkipped += 1;
            errors.push(
              `${reminderConfig.reminderType} failed for meeting ${meeting.meeting_id} item ${candidate.index}: ${result.error}`,
            );
          } else {
            sentNow = true;
            emailsSent += 1;
          }
        }

        if (sentNow) {
          await recordReminderEvent({
            meetingId: meeting.meeting_id,
            promiseIndex: candidate.index,
            reminderType: reminderConfig.reminderType,
            scheduledFor: options.targetDateIso,
            email: meeting.user_email,
            subject: content.subject,
            meta: {
              task: candidate.item.task,
              due_date: candidate.effectiveDueDate,
            },
          });
        }
      }
    }
  }

  return NextResponse.json({
    status: "ok",
    run_date: options.targetDateIso,
    dry_run: options.dryRun,
    meetings_scanned: meetingsScanned,
    emails_attempted: emailsAttempted,
    emails_sent: emailsSent,
    emails_skipped: emailsSkipped,
    errors,
  });
}

async function resolveRequestOptions(request: Request): Promise<{
  targetDateIso: string;
  dryRun: boolean;
}> {
  const url = new URL(request.url);
  let targetDateIso = parseDateInput(url.searchParams.get("date"));
  let dryRun = parseBoolean(url.searchParams.get("dry_run"));

  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await request.json().catch(() => null)) as
        | { date?: string; dry_run?: boolean | string }
        | null;
      if (body?.date) targetDateIso = parseDateInput(body.date);
      if (typeof body?.dry_run !== "undefined") {
        if (typeof body.dry_run === "boolean") {
          dryRun = body.dry_run;
        } else {
          dryRun = parseBoolean(body.dry_run);
        }
      }
    }
  }

  return {
    targetDateIso,
    dryRun,
  };
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized reminder run." }, { status: 401 });
  }
  const options = await resolveRequestOptions(request);
  return runReminderJob(request, options);
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized reminder run." }, { status: 401 });
  }
  const options = await resolveRequestOptions(request);
  return runReminderJob(request, options);
}

