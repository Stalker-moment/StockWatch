import { NextResponse } from "next/server";
import { MarketError, getDirectory } from "../../../../lib/live-market";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getDirectory();
    return NextResponse.json(
      { ok: true, data },
      { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } },
    );
  } catch (error) {
    const status = error instanceof MarketError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Terjadi kesalahan pada API";
    return NextResponse.json(
      { ok: false, message },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
