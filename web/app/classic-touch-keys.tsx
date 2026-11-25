"use client";

import { useEffect, useState } from "react";

export type TouchKey = { value: string; text: string; label: string; caption?: string; pressed?: boolean };
export const escapeKey: TouchKey = { value: "escape", text: "Esc", label: "Kembali atau batal" };
export const enterKey: TouchKey = { value: "enter", text: "Enter", label: "Konfirmasi atau buka detail" };
export const backspaceKey: TouchKey = { value: "backspace", text: "⌫", label: "Hapus karakter" };
export const keyboardKey: TouchKey = { value: "keyboard", text: "⌨", label: "Buka keyboard ponsel" };

export function editWithKey(
  field: HTMLInputElement | null, value: string, key: string, setValue: (value: string) => void, limit = 50,
) {
  const start = field?.selectionStart ?? value.length;
  const end = field?.selectionEnd ?? start;
  const from = key === "backspace" && start === end ? Math.max(0, start - 1) : start;
  const insert = key === "backspace" ? "" : key;
  const next = value.slice(0, from) + insert + value.slice(end);
  if (next.length > limit) return;
  setValue(next);
  requestAnimationFrame(() => field?.setSelectionRange(from + insert.length, from + insert.length));
}

export default function ClassicTouchKeys({ rows, onKey }: {
  rows: TouchKey[][]; onKey: (value: string) => void;
}) {
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => {
      const inset = viewport.scale === 1 ? window.innerHeight - viewport.height - viewport.offsetTop : 0;
      setOffset(Math.max(0, Math.round(inset)));
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    window.addEventListener("resize", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, []);

  return (
    <div className="cmd-touch-keys" role="group" aria-label="Keyboard terminal"
      data-key-rows={rows.length} style={{ bottom: offset }}
      onPointerDown={(event) => {
        // Tetap dekatkan keyboard ke kolom yang sedang diisi saat tombol tambahan disentuh.
        if (document.activeElement instanceof HTMLInputElement && document.activeElement.closest(".cmd-shell"))
          event.preventDefault();
      }}>
      {rows.map((row, index) => (
        <div className="cmd-touch-row" key={index}>
          {row.map((key) => (
            <button type="button" key={key.value} aria-label={key.label} aria-pressed={key.pressed}
              onClick={() => onKey(key.value)}>
              <kbd>{key.text}</kbd>{key.caption && <small>{key.caption}</small>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

