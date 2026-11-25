import type { Metadata } from "next";
import SourceView from "./source-view";

export const metadata: Metadata = { title: "Kode C++ · StockWatch" };

export default function CodePage() {
  return <SourceView name="dashboard.cpp" />;
}

