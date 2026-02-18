import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { runQuery } from "@/lib/server/db";

export const runtime = "nodejs";

const RECORDINGS_DIR = path.join(process.cwd(), "tmp", "recordings");
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RouteContext = {
  params: Promise<{ meetingId: string }>;
};

type MeetingAudioRow = {
  audio_file: string | null;
};

function getAudioMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}

async function findAudioPath(meetingId: string): Promise<string | null> {
  const dbResult = await runQuery<MeetingAudioRow>(
    `
      select audio_file
      from meetings
      where meeting_id = $1
      limit 1
    `,
    [meetingId],
  );

  if (!dbResult.skipped && dbResult.rows.length > 0) {
    const storedPath = dbResult.rows[0].audio_file;
    if (storedPath && storedPath.startsWith("tmp/recordings/")) {
      return path.join(process.cwd(), storedPath);
    }
  }

  const candidates = [
    path.join(RECORDINGS_DIR, `${meetingId}.webm`),
    path.join(RECORDINGS_DIR, `${meetingId}.mp3`),
    path.join(RECORDINGS_DIR, `${meetingId}.wav`),
  ];

  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // keep checking
    }
  }

  return null;
}

export async function GET(_request: Request, context: RouteContext) {
  const { meetingId } = await context.params;
  if (!UUID_REGEX.test(meetingId)) {
    return NextResponse.json({ error: "Invalid meeting id." }, { status: 400 });
  }

  const audioPath = await findAudioPath(meetingId);
  if (!audioPath) {
    return NextResponse.json({ error: "Audio file not found." }, { status: 404 });
  }

  try {
    const bytes = await readFile(audioPath);
    const filename = path.basename(audioPath);
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": getAudioMimeType(audioPath),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to read audio file." }, { status: 500 });
  }
}
