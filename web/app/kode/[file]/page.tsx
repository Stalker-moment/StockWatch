import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { sourceFiles } from "../../../lib/cpp-source";
import SourceView from "../source-view";

type Props = { params: Promise<{ file: string }> };

export const dynamicParams = false;

export async function generateStaticParams() {
  return (await sourceFiles()).map(({ slug }) => ({ file: slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { file } = await params;
  const item = (await sourceFiles()).find(({ slug }) => slug === file);
  return { title: item ? item.name + " · StockWatch" : "Kode C++ · StockWatch" };
}

export default async function SourcePage({ params }: Props) {
  const { file } = await params;
  const item = (await sourceFiles()).find(({ slug }) => slug === file);
  if (!item) notFound();
  return <SourceView name={item.name} />;
}

