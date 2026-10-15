/** A scrolling transcript that programs print to and that can ask for a line of input inline. */

export class Terminal {
  constructor(readonly el: HTMLElement) {}

  private append(node: HTMLElement): HTMLElement {
    const stick = this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    this.el.append(node);
    if (stick) this.el.scrollTop = this.el.scrollHeight;
    return node;
  }

  private block(cls: string): HTMLElement {
    const div = document.createElement("div");
    div.className = cls;
    return div;
  }

  /** A line of program output. */
  print(line: string, cls = "out"): void {
    const div = this.block(cls);
    div.textContent = line;
    this.append(div);
  }

  /** Pre-rendered, already escaped HTML (diagnostics, highlighted code). */
  html(html: string, cls: string): HTMLElement {
    const div = this.block(cls);
    div.innerHTML = html;
    return this.append(div);
  }

  clear(): void {
    this.el.replaceChildren();
  }

  /**
   * Show an inline input field and call `done` with the submitted line, or with
   * `undefined` on Ctrl+D (end of input). Returns a function that withdraws the request.
   */
  ask(type: string, done: (line: string | undefined) => void): () => void {
    const row = this.block("ask");
    const label = document.createElement("label");
    label.textContent = `INPUT ${type}`;
    const field = document.createElement("input");
    field.id = `ask-${Math.random().toString(36).slice(2)}`;
    label.htmlFor = field.id;
    field.autocomplete = "off";
    field.spellcheck = false;
    field.placeholder = "type a value, Enter to send · Ctrl+D ends input";
    row.append(label, field);
    this.append(row);
    field.focus({ preventScroll: true });

    const finish = (line: string | undefined) => {
      field.removeEventListener("keydown", onKey);
      row.classList.add("answered");
      field.readOnly = true;
      if (line === undefined) field.value = "(end of input)";
      done(line);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(field.value);
      } else if (e.key === "d" && e.ctrlKey) {
        e.preventDefault();
        finish(undefined);
      }
    };
    field.addEventListener("keydown", onKey);
    return () => {
      if (row.classList.contains("answered")) return;
      field.removeEventListener("keydown", onKey);
      row.remove();
    };
  }
}
