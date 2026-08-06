import { useEffect, useState } from "react";
import { useStdout } from "ink";
import { output } from "../args";

// Monotonic frame counter driving every animated glyph. Frozen under --plain so piped output is stable.
export function useFrame(interval = 80): number {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (output.plain) {
      return;
    }

    const timer = setInterval(() => setFrame((current) => current + 1), interval);
    return () => clearInterval(timer);
  }, [interval]);

  return frame;
}

// Terminal size that re-renders on resize — for full-height layouts that pin something to the last row.
// termCols() in ./format stays for one-shot commands that only need the width once.
export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const read = () => ({
    columns: Math.max(40, stdout?.columns || 80),
    rows: Math.max(10, stdout?.rows || 24),
  });
  const [size, setSize] = useState(read);

  useEffect(() => {
    if (!stdout) {
      return;
    }

    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
