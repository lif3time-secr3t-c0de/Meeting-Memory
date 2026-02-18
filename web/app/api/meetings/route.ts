import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { upsertMeetingUpload } from "@/lib/server/meetings-repo";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/mpeg",
  "audio/mp3",
]);

function resolveExtension(file: File): "webm" | "mp3" | null {
  const type = file.type.toLowerCase();
  if (type.includes("webm")) return "webm";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";

  const name = file.name.toLowerCase();
  if (name.endsWith(".webm")) return "webm";
  if (name.endsWith(".mp3")) return "mp3";
  return null;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    const userEmail = formData.get("user_email");

    if (!(audio instanceof File)) {
      return NextResponse.json(
        { error: "Missing audio file. Expected form-data field 'audio'." },
        { status: 400 },
      );
    }

    if (audio.size === 0) {
      return NextResponse.json({ error: "Audio file is empty." }, { status: 400 });
    }

    if (audio.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: "Audio file is larger than 50MB." },
        { status: 413 },
      );
    }

    const extension = resolveExtension(audio);
    const allowedByType = audio.type ? ALLOWED_MIME_TYPES.has(audio.type.toLowerCase()) : false;
    if (!extension && !allowedByType) {
      return NextResponse.json(
        { error: "Unsupported audio format. Use WebM or MP3." },
        { status: 415 },
      );
    }

    const meetingId = crypto.randomUUID();
    const resolvedExtension = extension ?? (audio.type.includes("mpeg") ? "mp3" : "webm");

    const targetDir = path.join(process.cwd(), "tmp", "recordings");
    await mkdir(targetDir, { recursive: true });

    const filename = `${meetingId}.${resolvedExtension}`;
    const filePath = path.join(targetDir, filename);
    const bytes = Buffer.from(await audio.arrayBuffer());
    await writeFile(filePath, bytes);

    const resolvedEmail =
      typeof userEmail === "string" && userEmail.trim().length > 0
        ? userEmail.trim()
        : "unknown@example.com";
    const storedAs = path.join("tmp", "recordings", filename);
    const databaseSaved = await upsertMeetingUpload({
      meetingId,
      audioFile: storedAs,
      userEmail: resolvedEmail,
      meetingDate: new Date(),
    });

    return NextResponse.json({
      meeting_id: meetingId,
      mime_type: audio.type || `audio/${resolvedExtension}`,
      size_bytes: audio.size,
      user_email: resolvedEmail,
      stored_as: storedAs,
      database_saved: databaseSaved,
      message: "Got it, processing now",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error while uploading audio.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
