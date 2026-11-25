import Link from "next/link";
import { readCpp, sourceFiles } from "../../lib/cpp-source";
import CopySource from "./copy-source";

export default async function SourceView({ name }: { name: string }) {
  const [files, { source, html, lines }] = await Promise.all([sourceFiles(), readCpp(name)]);
  return (
    <main className="source-page">
      <header className="source-title">
        <h1>Kode sumber</h1>
        <span className="source-meta">C++ · Hanya baca</span>
      </header>
      <div className="source-layout">
        <aside className="source-tree" aria-label="File sumber">
          <h2>File proyek</h2>
          <div className="source-folder" aria-label="Folder src"><span aria-hidden="true" />src</div>
          <nav aria-label="Daftar file C++">
            {files.map((file) => (
              <Link key={file.slug} href={"/kode/" + file.slug + "/"} prefetch={false}
                aria-current={name === file.name ? "page" : undefined}>
                <span className="source-file-icon" aria-hidden="true" />{file.name}
              </Link>
            ))}
          </nav>
        </aside>
        <section className="source-file" aria-labelledby="source-file-title">
          <header>
            <div><h2 id="source-file-title"><span>src</span> <span aria-hidden="true">/</span> {name}</h2><span className="source-file-stat">{lines} baris</span></div>
            <CopySource key={name} source={source} />
          </header>
          <div className="source-code" tabIndex={0} aria-label={"Kode " + name}
            dangerouslySetInnerHTML={{ __html: html }} />
        </section>
      </div>
    </main>
  );
}

