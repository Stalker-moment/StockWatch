import { NextResponse } from "next/server";
import { MarketError, getQuote } from "../../../../lib/live-market";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ code: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const { code } = await context.params;
    const data = await getQuote(decodeURIComponent(code));
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
