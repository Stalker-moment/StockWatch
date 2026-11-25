"use client";

import { useState } from "react";

export default function CopySource({ source }: { source: string }) {
  const [status, setStatus] = useState("");
  async function copy() {
    try {
      await navigator.clipboard.writeText(source);
      setStatus("Disalin");
    } catch {
      setStatus("Salin manual dari panel kode");
    }
  }
  return (
    <div className="source-copy">
      {status && <span role="status">{status}</span>}
      <button type="button" onClick={copy}>Salin kode</button>
    </div>
  );
}

