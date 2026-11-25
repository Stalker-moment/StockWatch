import { NextResponse } from "next/server";
import { MarketError, getCompare } from "../../../../lib/live-market";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const codes = url.searchParams.get("codes") || "";
    const data = await getCompare(codes);
    return NextResponse.json(
      { ok: true, data },
      { headers: { "Cache-Control": "public, s-maxage=5, stale-while-revalidate=10" } },
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
