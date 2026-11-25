import { NextResponse } from "next/server";
import { MarketError, getHistory } from "../../../../../lib/live-market";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ code: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { code } = await context.params;
    const url = new URL(request.url);
    const range = url.searchParams.get("range") || "1mo";
    const data = await getHistory(decodeURIComponent(code), range);
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
