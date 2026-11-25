import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { codeToHtml } from "shiki";

const sourceDir = resolve(process.cwd(), "../src");
const filePattern = /^[a-z_]+\.(?:cpp|hpp)$/;

export async function sourceFiles() {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && filePattern.test(entry.name))
    .map(({ name }) => ({ name, slug: name.replace(".", "-") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function readCpp(file: string) {
  if (!filePattern.test(file)) throw new Error("Nama file C++ tidak valid.");
  const source = await readFile(resolve(sourceDir, file), "utf8");
  return {
    source,
    html: await codeToHtml(source, { lang: "cpp", theme: "github-dark-default" }),
    lines: source.split(/\r?\n/).length - Number(source.endsWith("\n")),
  };
}

