/** The Files tab: browse and edit the virtual file system that OPENFILE uses. */

import { BehaviorSubject, debounceTime, fromEvent, merge, type Observable } from "rxjs";
import { escapeHtml, type VirtualFs } from "../src/mod.ts";
import { $ } from "./dom.ts";

export function mountFiles(fs: VirtualFs, changed$: Observable<void>, save: () => void): void {
  const list = $("file-list");
  const body = $<HTMLTextAreaElement>("file-text");
  const remove = $<HTMLButtonElement>("file-delete");
  const open$ = new BehaviorSubject<string | undefined>(undefined);

  merge(changed$, open$).subscribe(() => {
    const open = open$.value;
    list.dataset.empty = "The virtual file system is empty. OPENFILE ... FOR WRITE creates files here; " +
      "files created below can be read with OPENFILE ... FOR READ.";
    list.replaceChildren(
      ...[...fs.files.keys()].sort().map((name) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("aria-current", String(name === open));
        const lines = fs.files.get(name)!.split("\n").filter(Boolean).length;
        b.innerHTML = `<span>${escapeHtml(name)}</span><small>${lines} line${lines === 1 ? "" : "s"}</small>`;
        b.addEventListener("click", () => open$.next(name));
        li.append(b);
        return li;
      }),
    );
    $("file-open-name").textContent = open ?? "No file selected";
    body.disabled = !open || !fs.files.has(open);
    body.value = open ? fs.files.get(open) ?? "" : "";
    remove.hidden = !open;
    remove.textContent = "Delete";
  });

  fromEvent(body, "input").pipe(debounceTime(200)).subscribe(() => {
    if (!open$.value) return;
    fs.files.set(open$.value, body.value);
    save();
  });

  // Deleting takes two clicks: the first turns the button into a confirmation.
  fromEvent(remove, "click").subscribe(() => {
    const open = open$.value;
    if (!open) return;
    if (remove.textContent === "Delete") {
      remove.textContent = `Delete ${open}? Click again to confirm`;
      return;
    }
    fs.files.delete(open);
    save();
    open$.next(undefined);
  });

  fromEvent<SubmitEvent>($("new-file"), "submit").subscribe((e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("new-file-name");
    const name = input.value.trim();
    if (!name) return;
    if (!fs.files.has(name)) fs.files.set(name, "");
    save();
    input.value = "";
    open$.next(name);
    body.focus();
  });
}
