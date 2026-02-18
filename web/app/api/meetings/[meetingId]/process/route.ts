import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { runQuery } from "@/lib/server/db";
import { sendReminderEmail } from "@/lib/server/email";
import { setMeetingStatus, upsertMeetingTranscript } from "@/lib/server/meetings-repo";
import { createMeetingInboxToken } from "@/lib/server/reminder-token";
import {
  ensureReminderTables,
  hasReminderEvent,
  recordReminderEvent,
} from "@/lib/server/reminders-repo";
import { extractActionItems } from "@/lib/server/action-items";

export const runtime = "nodejs";
export const maxDuration = 900;

const RECORDINGS_DIR = path.join(process.cwd(), "tmp", "recordings");
const TRANSCRIPTS_DIR = path.join(process.cwd(), "tmp", "transcripts");
const SCRIPT_PATH = path.join(process.cwd(), "python", "transcribe_with_whisper.py");
const MAX_PROCESSING_MS = 20 * 60 * 1000;
const ALLOWED_MODELS = new Set(["tiny", "base"]);
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ meetingId: string }>;
};

type MeetingEmailRow = {
  user_email: string;
  date: Date | string | null;
};

type WhisperSuccess = {
  ok: true;
  meeting_id: string;
  model: "tiny" | "base";
  duration_seconds: number;
  processing_seconds: number;
  segment_count: number;
  transcript_text: string;
  quality?: {
    avg_no_speech_prob?: number;
    avg_logprob?: number;
    avg_compression_ratio?: number;
  };
};

type WhisperFailure = {
  ok: false;
  error_code?: string;
  message?: string;
  details?: string;
  duration_seconds?: number;
  quality?: {
    avg_no_speech_prob?: number;
    avg_logprob?: number;
    avg_compression_ratio?: number;
  };
};

type WhisperPayload = WhisperSuccess | WhisperFailure;

type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: Error | null;
};

function pickModel(input: unknown): "tiny" | "base" {
  if (typeof input === "string" && ALLOWED_MODELS.has(input)) {
    return input as "tiny" | "base";
  }
  return "base";
}

async function resolveAudioPath(meetingId: string): Promise<string | null> {
  const files = await readdir(RECORDINGS_DIR).catch(() => []);
  const found = files.find(
    (filename) => filename === `${meetingId}.webm` || filename === `${meetingId}.mp3`,
  );
  if (!found) return null;
  return path.join(RECORDINGS_DIR, found);
}

async function ensureScriptExists(): Promise<boolean> {
  try {
    await access(SCRIPT_PATH, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parsePayload(stdout: string): WhisperPayload | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]) as WhisperPayload;
      if (typeof parsed === "object" && parsed !== null && "ok" in parsed) {
        return parsed;
      }
    } catch {
      // Continue searching for JSON line.
    }
  }

  return null;
}

function runCommand(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeout: NodeJS.Timeout | null = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, MAX_PROCESSING_MS);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      resolve({
        stdout,
        stderr,
        exitCode: null,
        timedOut,
        spawnError: error,
      });
    });

    child.on("close", (exitCode) => {
      if (timeout) clearTimeout(timeout);
      timeout = null;
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        spawnError: null,
      });
    });
  });
}

function mapUserMessage(payload: WhisperFailure): string {
  switch (payload.error_code) {
    case "too_long":
      return "Please split into 1 hour parts";
    case "unclear_audio":
      return "Couldn't hear clearly. Try speaking slower and clearer, and keep the microphone closer.";
    case "background_noise":
      return "Too much background noise detected. Try a quieter place or a closer mic.";
    default:
      return payload.message || "Transcription failed.";
  }
}

function mapStatusCode(payload: WhisperFailure): number {
  switch (payload.error_code) {
    case "too_long":
      return 400;
    case "unclear_audio":
    case "background_noise":
      return 422;
    case "missing_file":
      return 404;
    case "dependency_missing":
      return 500;
    default:
      return 500;
  }
}

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

function shouldDeleteAudioAfterProcessing(): boolean {
  const raw = process.env.DELETE_AUDIO_AFTER_PROCESSING?.trim().toLowerCase();
  if (!raw) return true;
  return raw === "1" || raw === "true" || raw === "yes";
}

function buildQualityWarnings(input: WhisperSuccess["quality"] | undefined): string[] {
  if (!input) return [];
  const warnings: string[] = [];
  const avgNoSpeechProb = input.avg_no_speech_prob ?? 0;
  const avgLogprob = input.avg_logprob ?? 0;
  const avgCompressionRatio = input.avg_compression_ratio ?? 0;

  if (avgNoSpeechProb >= 0.55) {
    warnings.push(
      "Large parts of the recording were hard to detect as speech. Try clearer speaking and a closer microphone.",
    );
  }

  if (avgCompressionRatio > 2.2 && avgLogprob < -0.75) {
    warnings.push(
      "Background noise may reduce accuracy. A quieter place will improve transcription and action-item extraction.",
    );
  }

  return warnings;
}

export async function POST(request: Request, context: RouteContext) {
  const { meetingId } = await context.params;

  if (!UUID_REGEX.test(meetingId)) {
    return NextResponse.json({ error: "Invalid meeting id." }, { status: 400 });
  }

  if (!(await ensureScriptExists())) {
    return NextResponse.json(
      { error: "Whisper script is missing. Expected web/python/transcribe_with_whisper.py." },
      { status: 500 },
    );
  }

  const audioPath = await resolveAudioPath(meetingId);
  if (!audioPath) {
    return NextResponse.json(
      { error: "Meeting audio file not found for this meeting id." },
      { status: 404 },
    );
  }
  const audioFileLink = path.join("tmp", "recordings", path.basename(audioPath));

  let modelInput: unknown = undefined;
  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = (await request.json()) as { model?: unknown };
      modelInput = body.model;
    } catch {
      modelInput = undefined;
    }
  }
  const queryModel = new URL(request.url).searchParams.get("model");
  const model = pickModel(modelInput ?? queryModel);
  await setMeetingStatus(meetingId, "transcribing", null);

  const pythonCandidates: Array<{ command: string; prefixArgs: string[] }> = [];
  const configuredPath = process.env.WHISPER_PYTHON_PATH?.trim();
  if (configuredPath) pythonCandidates.push({ command: configuredPath, prefixArgs: [] });
  pythonCandidates.push(
    { command: path.join(process.cwd(), ".venv", "Scripts", "python.exe"), prefixArgs: [] },
    { command: path.join(process.cwd(), ".venv", "bin", "python"), prefixArgs: [] },
  );
  pythonCandidates.push(
    { command: "python", prefixArgs: [] },
    { command: "python3", prefixArgs: [] },
    { command: "py", prefixArgs: ["-3"] },
  );

  let lastExec: ExecResult | null = null;
  let payload: WhisperPayload | null = null;
  let executed = false;

  for (const candidate of pythonCandidates) {
    const args = [
      ...candidate.prefixArgs,
      SCRIPT_PATH,
      "--input",
      audioPath,
      "--model",
      model,
      "--meeting-id",
      meetingId,
    ];

    const exec = await runCommand(candidate.command, args);
    lastExec = exec;

    if (exec.spawnError) {
      const errorCode = (exec.spawnError as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") continue;
      return NextResponse.json(
        {
          error: "Failed to launch Python for Whisper processing.",
          details: exec.spawnError.message,
        },
        { status: 500 },
      );
    }

    executed = true;
    payload = parsePayload(exec.stdout);

    if (payload) break;

    if (exec.timedOut) {
      await setMeetingStatus(
        meetingId,
        "failed",
        "Whisper timed out. 1 hour meetings can take 5-10 minutes. Please retry.",
      );
      return NextResponse.json(
        {
          error: "Whisper timed out. 1 hour meetings can take 5-10 minutes. Please retry.",
        },
        { status: 504 },
      );
    }

    if (exec.exitCode !== 0) {
      break;
    }
  }

  if (!executed) {
    await setMeetingStatus(
      meetingId,
      "failed",
      "Python was not found. Install Python and dependencies before using Whisper.",
    );
    return NextResponse.json(
      {
        error:
          "Python was not found. Install Python and dependencies before using Whisper.",
      },
      { status: 500 },
    );
  }

  if (!payload) {
    await setMeetingStatus(meetingId, "failed", "Whisper returned an invalid response.");
    return NextResponse.json(
      {
        error: "Whisper returned an invalid response.",
        details: lastExec?.stderr || lastExec?.stdout || null,
      },
      { status: 500 },
    );
  }

  if (!payload.ok) {
    const userMessage = mapUserMessage(payload);
    await setMeetingStatus(meetingId, "failed", userMessage);
    return NextResponse.json(
      {
        error: userMessage,
        error_code: payload.error_code ?? "transcription_failed",
        details: payload.details ?? null,
        quality: payload.quality ?? null,
      },
      { status: mapStatusCode(payload) },
    );
  }

  await mkdir(TRANSCRIPTS_DIR, { recursive: true });
  const meetingTimestamp = new Date();
  const promisesList = extractActionItems(payload.transcript_text, meetingTimestamp);
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${meetingId}.json`);
  await writeFile(
    transcriptPath,
    JSON.stringify(
      {
        meeting_id: payload.meeting_id,
        model: payload.model,
        duration_seconds: payload.duration_seconds,
        processing_seconds: payload.processing_seconds,
        segment_count: payload.segment_count,
        transcript_text: payload.transcript_text,
        promises_list: promisesList,
        quality: payload.quality ?? null,
        created_at: meetingTimestamp.toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  const databaseSaved = await upsertMeetingTranscript({
    meetingId: payload.meeting_id,
    transcriptText: payload.transcript_text,
    audioFile: audioFileLink,
    promisesList,
    meetingDate: meetingTimestamp,
  });
  let summaryEmailSent = false;
  let summaryEmailError: string | null = null;
  if (databaseSaved) {
    const meetingRow = await runQuery<MeetingEmailRow>(
      `
        select user_email, date
        from meetings
        where meeting_id = $1
        limit 1
      `,
      [payload.meeting_id],
    );

    const recipient = meetingRow.rows[0]?.user_email?.trim().toLowerCase() ?? "";
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient);
    const shouldNotify = validEmail && recipient !== "unknown@example.com";
    if (shouldNotify) {
      const reminderTablesReady = await ensureReminderTables();
      const persistedDate = meetingRow.rows[0]?.date;
      const summaryDateIso = (() => {
        if (!persistedDate) return meetingTimestamp.toISOString().slice(0, 10);
        const parsed = persistedDate instanceof Date ? persistedDate : new Date(persistedDate);
        if (Number.isNaN(parsed.getTime())) return meetingTimestamp.toISOString().slice(0, 10);
        return parsed.toISOString().slice(0, 10);
      })();
      let alreadySent = false;
      if (reminderTablesReady) {
        alreadySent = await hasReminderEvent(
          payload.meeting_id,
          -2,
          "summary_ready",
          summaryDateIso,
        );
      }

      if (!alreadySent) {
        const baseUrl = resolveBaseUrl(request);
        const inboxToken = createMeetingInboxToken({ email: recipient });
        const meetingUrl = `${baseUrl}/?meeting_id=${encodeURIComponent(payload.meeting_id)}`;
        const meetingsUrl = `${baseUrl}/?inbox=${encodeURIComponent(inboxToken)}`;

        const result = await sendReminderEmail({
          to: recipient,
          subject: "Your meeting summary is ready",
          text: [
            "Your meeting has been processed.",
            "",
            `Open this meeting: ${meetingUrl}`,
            `View all meetings: ${meetingsUrl}`,
          ].join("\n"),
        });

        if (result.sent) {
          summaryEmailSent = true;
          if (reminderTablesReady) {
            await recordReminderEvent({
              meetingId: payload.meeting_id,
              promiseIndex: -2,
              reminderType: "summary_ready",
              scheduledFor: summaryDateIso,
              email: recipient,
              subject: "Your meeting summary is ready",
              meta: {
                meeting_url: meetingUrl,
                inbox_url: meetingsUrl,
              },
            });
          }
        } else {
          summaryEmailError = result.error ?? "Failed to send summary email.";
        }
      }
    }
  }

  let audioDeletedAfterProcessing = false;
  if (databaseSaved && shouldDeleteAudioAfterProcessing()) {
    await rm(audioPath, { force: true }).catch(() => null);
    const cleared = await runQuery(
      `
        update meetings
        set audio_file = null
        where meeting_id = $1
      `,
      [payload.meeting_id],
    );
    audioDeletedAfterProcessing = !cleared.skipped;
  }

  const audioDownloadUrl = audioDeletedAfterProcessing
    ? null
    : `/api/meetings/${payload.meeting_id}/audio`;

  return NextResponse.json({
    status: "complete",
    meeting_id: payload.meeting_id,
    model: payload.model,
    duration_seconds: payload.duration_seconds,
    processing_seconds: payload.processing_seconds,
    segment_count: payload.segment_count,
    quality: payload.quality ?? null,
    warnings: buildQualityWarnings(payload.quality),
    transcript_text: payload.transcript_text,
    promises_list: promisesList,
    audio_file: audioDeletedAfterProcessing ? null : audioFileLink,
    audio_download_url: audioDownloadUrl,
    meeting_timestamp: meetingTimestamp.toISOString(),
    database_saved: databaseSaved,
    summary_email_sent: summaryEmailSent,
    summary_email_error: summaryEmailError,
    audio_deleted_after_processing: audioDeletedAfterProcessing,
    transcript_path: path.join("tmp", "transcripts", `${meetingId}.json`),
    message: "Whisper transcription complete.",
  });
}

export async function GET(_request: Request, context: RouteContext) {
  const { meetingId } = await context.params;
  if (!UUID_REGEX.test(meetingId)) {
    return NextResponse.json({ error: "Invalid meeting id." }, { status: 400 });
  }

  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${meetingId}.json`);
  try {
    const raw = await readFile(transcriptPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return NextResponse.json({
      status: "ready",
      ...parsed,
    });
  } catch {
    return NextResponse.json({ status: "not_ready" }, { status: 404 });
  }
}
