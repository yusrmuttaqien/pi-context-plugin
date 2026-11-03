import {
  type Component,
  type SelectListTheme,
  type KeybindingsManager,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

// Shared theme for the built-in SelectList pickers, built from the active pi theme.
export function selectTheme(theme: { fg(color: string, text: string): string }): SelectListTheme {
  return {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("dim", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  };
}

// Border + padding wrapper: draws a box around a child component so overlays
// read as dialogs rather than floating text. Adds 1 column of left/right and
// 1 row of top/bottom padding inside the border.
export class Panel implements Component {
  private child: Component;
  private border: (t: string) => string;
  constructor(child: Component, border: (t: string) => string) {
    this.child = child;
    this.border = border;
  }
  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const padX = 1;
    const contentWidth = Math.max(1, inner - 2 * padX);
    const childLines = this.child.render(contentWidth);
    const out: string[] = [this.border("┌" + "─".repeat(inner) + "┐")];
    out.push(this.border("│") + " ".repeat(inner) + this.border("│"));
    for (const line of childLines) {
      const content = " ".repeat(padX) + truncateToWidth(line, contentWidth, undefined, true) + " ".repeat(padX);
      out.push(this.border("│") + content + this.border("│"));
    }
    out.push(this.border("│") + " ".repeat(inner) + this.border("│"));
    out.push(this.border("└" + "─".repeat(inner) + "┘"));
    return out;
  }
  handleInput(data: string): void {
    this.child.handleInput?.(data);
  }
  invalidate(): void {
    this.child.invalidate();
  }
}

// Prepends header lines (e.g. a question) above a child component. Header
// lines are wrapped to the render width so long paths wrap instead of clipping.
export class WithHeader implements Component {
  private header: string[];
  private child: Component;
  constructor(header: string[], child: Component) {
    this.header = header;
    this.child = child;
  }
  render(width: number): string[] {
    const headerLines: string[] = [];
    for (const line of this.header) {
      headerLines.push(...(line === "" ? [""] : wrapTextWithAnsi(line, width)));
    }
    return [...headerLines, ...this.child.render(width)];
  }
  handleInput(data: string): void {
    this.child.handleInput?.(data);
  }
  invalidate(): void {
    this.child.invalidate();
  }
}

// A grouped, internally-scrolling list: bold directory headers above their
// sessions, with the selection kept in view and a (n/total) indicator.
export type ListRow =
  | { kind: "header"; text: string }
  | { kind: "item"; value: string; label: string; description: string }
  | { kind: "spacer" };

export interface ListStyles {
  header: (t: string) => string;
  selected: (t: string) => string;
  dim: (t: string) => string;
  noMatch: (t: string) => string;
  scroll: (t: string) => string;
}

export class GroupedList implements Component {
  private rows: ListRow[];
  private itemRowIdx: number[];
  private selected = 0;
  private top = 0;
  private readonly maxVisible: number;
  private styles: ListStyles;
  private kb: KeybindingsManager;
  private onSelect: (value: string) => void;
  private onCancel: () => void;
  private onDelete?: (value: string, label: string) => Promise<void>;
  private requestRender?: () => void;
  private confirming = false;
  private deleteTarget: string | null = null;
  private deleteLabel = "";

  constructor(
    rows: ListRow[],
    maxVisible: number,
    styles: ListStyles,
    kb: KeybindingsManager,
    onSelect: (value: string) => void,
    onCancel: () => void,
    onDelete?: (value: string, label: string) => Promise<void>,
    requestRender?: () => void,
  ) {
    this.rows = rows;
    this.maxVisible = maxVisible;
    this.styles = styles;
    this.kb = kb;
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.onDelete = onDelete;
    this.requestRender = requestRender;
    this.itemRowIdx = rows.map((r, i) => (r.kind === "item" ? i : -1)).filter((i) => i >= 0);
    if (this.itemRowIdx.length > 0) this.top = Math.max(0, this.itemRowIdx[0] - 1);
  }

  setRows(rows: ListRow[]): void {
    this.rows = rows;
    this.itemRowIdx = rows.map((r, i) => (r.kind === "item" ? i : -1)).filter((i) => i >= 0);
    this.selected = 0;
    this.top = 0;
    if (this.itemRowIdx.length > 0) this.top = Math.max(0, this.itemRowIdx[0] - 1);
    this.requestRender?.();
  }

  private ensureVisible(): void {
    const selRow = this.itemRowIdx[this.selected];
    if (selRow < this.top) this.top = selRow;
    else if (selRow >= this.top + this.maxVisible) this.top = selRow - this.maxVisible + 1;
    if (this.top < 0) this.top = 0;
  }

  render(width: number): string[] {
    const total = this.itemRowIdx.length;
    if (total === 0) return [this.styles.noMatch("No sessions")];
    const lines: string[] = [];
    const visible = this.rows.slice(this.top, this.top + this.maxVisible);
    for (let i = 0; i < visible.length; i++) {
      const rowIdx = this.top + i;
      const row = visible[i];
      if (row.kind === "header") {
        lines.push(this.styles.header(row.text));
      } else if (row.kind === "spacer") {
        lines.push("");
      } else {
        const isSelected = this.itemRowIdx[this.selected] === rowIdx;
        const prefix = isSelected ? "→ " : "  ";
        const label = isSelected ? this.styles.selected(row.label) : row.label;
        const desc = row.description ? "  " + this.styles.dim(row.description) : "";
        lines.push(prefix + label + desc);
      }
    }
    lines.push(this.styles.scroll(`(${this.selected + 1}/${total})`));
    if (this.confirming) {
      lines.push("");
      lines.push(this.styles.selected(`Delete \u201c${this.deleteLabel}\u201d?  y/n`));
    }
    return lines;
  }

  handleInput(data: string): void {
    if (this.confirming) {
      if (data === "y" || this.kb.matches(data, "tui.select.confirm")) {
        const target = this.deleteTarget!;
        const label = this.deleteLabel;
        this.confirming = false;
        this.deleteTarget = null;
        this.onDelete?.(target, label).then(() => {
          this.requestRender?.();
        });
      } else if (data === "n" || this.kb.matches(data, "tui.select.cancel")) {
        this.confirming = false;
        this.deleteTarget = null;
        this.requestRender?.();
      }
      return;
    }
    if (this.onDelete && data === "d") {
      const row = this.rows[this.itemRowIdx[this.selected]];
      if (row && row.kind === "item") {
        this.confirming = true;
        this.deleteTarget = row.value;
        this.deleteLabel = row.label;
        this.requestRender?.();
      }
      return;
    }
    if (this.kb.matches(data, "tui.select.up")) {
      if (this.selected > 0) {
        this.selected--;
        this.ensureVisible();
      }
    } else if (this.kb.matches(data, "tui.select.down")) {
      if (this.selected < this.itemRowIdx.length - 1) {
        this.selected++;
        this.ensureVisible();
      }
    } else if (this.kb.matches(data, "tui.select.confirm")) {
      const row = this.rows[this.itemRowIdx[this.selected]];
      if (row && row.kind === "item") this.onSelect(row.value);
    } else if (this.kb.matches(data, "tui.select.cancel")) {
      this.onCancel();
    }
  }

  invalidate(): void {
    // no cached state
  }
}
