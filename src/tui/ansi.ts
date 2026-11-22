/** ANSI helpers for the TUI (no runtime dependencies). */

export const ESC = "\x1b[";
export const codes = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  italic: `${ESC}3m`,
  underline: `${ESC}4m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
  gray: `${ESC}90m`,
  bgBlue: `${ESC}44m`,
  bgGray: `${ESC}100m`,
};

export const screen = {
  alternateOn: `${ESC}?1049h`,
  alternateOff: `${ESC}?1049l`,
  cursorHide: `${ESC}?25l`,
  cursorShow: `${ESC}?25h`,
  clear: `${ESC}2J`,
  home: `${ESC}H`,
  goto(row: number, col: number): string {
    return `${ESC}${Math.max(1, row)};${Math.max(1, col)}H`;
  },
  eraseLine: `${ESC}2K`,
  // 1000 reports button presses (enough for the wheel) without 1002 drag
  // motion, which is what interfered most with selecting text.
  mouseOn: `${ESC}?1006h${ESC}?1000h`,
  mouseOff: `${ESC}?1000l${ESC}?1006l`,
};

export function paint(text: string, color: string): string {
  return `${color}${text}${codes.reset}`;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** Number of columns a string actually occupies on screen. */
export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

const ANSI_TOKEN = /\x1b\[[0-9;?]*[a-zA-Z]|[^\x1b]/g;

/**
 * Wraps text to a visible-column width without splitting ANSI escape codes.
 * Color state is carried over to each wrapped line.
 */
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width);
  const result: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (visibleLength(paragraph) <= limit) {
      result.push(paragraph);
      continue;
    }

    let line = "";
    let used = 0;
    let active = "";
    const tokens = paragraph.match(ANSI_TOKEN) ?? [];

    const flush = () => {
      result.push(line);
      line = active;
      used = 0;
    };

    for (const token of tokens) {
      if (token.startsWith("\x1b[")) {
        line += token;
        if (token.endsWith("m")) active = token;
        continue;
      }
      if (used >= limit) flush();
      line += token;
      used++;
    }
    if (line || used > 0) result.push(line);
  }

  return result.length ? result : [""];
}

/** Removes control sequences that would corrupt the terminal display. */
export function sanitizeTerminalText(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?>=]*[a-zA-Z]/g, "") // CSI sequences
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""); // remaining C0 controls, including CR and ESC
}

export function box(lines: string[], width: number, title?: string): string[] {
  const inner = width - 2;
  const titleText = title ? `─ ${title} ` : "";
  const output = [`╭${titleText}${"─".repeat(Math.max(0, width - 4 - visibleLength(titleText) + 2))}╮`];
  for (const line of lines) {
    for (const piece of wrapText(line, inner)) {
      output.push(`│${piece}${" ".repeat(Math.max(0, inner - visibleLength(piece)))}│`);
    }
  }
  output.push(`╰${"─".repeat(Math.max(0, width - 2))}╯`);
  return output;
}
