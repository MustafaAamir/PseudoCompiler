/**
 * Presentational components. Everything the playground says about a program
 * (compile results, exit status, diagnostics, empty panels) is built from
 * these, so status reads as interface rather than as console text.
 */

import { type Diagnostic, escapeHtml, type Renderer } from "../src/mod.ts";

export type Tone = "ok" | "err" | "warn" | "info" | "neutral";
type Child = Node | string | false | null | undefined;

/** Create an element. Attributes starting with `on` become listeners; `html` sets innerHTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "html") el.innerHTML = String(v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else el.setAttribute(k === "className" ? "class" : k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Message text with `code` spans rendered as inline code. */
export function rich(text: string): HTMLSpanElement {
  return h("span", { html: escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>") });
}

export const badge = (text: string, tone: Tone = "neutral"): HTMLSpanElement =>
  h("span", { className: `badge ${tone}` }, text);

/** Label/value pairs laid out as a row of cells. */
export function metrics(pairs: [string, string | number][]): HTMLElement {
  return h(
    "dl",
    { className: "metrics" },
    ...pairs.map(([label, value]) =>
      h("div", {}, h("dt", {}, label), h("dd", {}, typeof value === "number" ? value.toLocaleString("en") : value))
    ),
  );
}

/** A status card: badge, title, optional explanation and figures. */
export function eventCard(o: {
  tone: Tone;
  badge: string;
  title: string;
  detail?: string;
  figures?: [string, string | number][];
}): HTMLElement {
  return h(
    "section",
    { className: `event ${o.tone}` },
    h("header", {}, badge(o.badge, o.tone), h("strong", {}, rich(o.title))),
    o.detail && h("p", {}, rich(o.detail)),
    o.figures && metrics(o.figures),
  );
}

/**
 * A diagnostic as a card: severity badge, code and message as a header, the
 * rustc-style source excerpt below. The renderer's own heading line is dropped
 * because the header replaces it.
 */
export function diagnosticCard(d: Diagnostic, r: Renderer, footer?: Child): HTMLElement {
  const [, ...body] = r.render(d).split("\n");
  const tone: Tone = d.isError ? "err" : "warn";
  return h(
    "article",
    { className: `diag-card ${tone}` },
    h(
      "header",
      {},
      badge(d.isError ? "Error" : "Warning", tone),
      h("code", { className: "diag-code" }, d.code),
      h("span", { className: "diag-msg" }, rich(d.message)),
    ),
    h("pre", { html: body.join("\n").replace(/\n+$/, "") }),
    footer,
  );
}

export function emptyState(title: string, body: string, ...extra: Child[]): HTMLElement {
  return h("div", { className: "empty" }, h("strong", {}, title), h("p", {}, rich(body)), ...extra);
}

/** Keyboard shortcut chips: `[["Ctrl+Enter", "run"], ...]`. */
export function shortcuts(keys: [string, string][]): HTMLElement {
  return h("ul", { className: "shortcuts" }, ...keys.map(([k, what]) => h("li", {}, h("kbd", {}, k), what)));
}
