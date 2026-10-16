/**
 * Builds the playground into dist/:
 *
 * - `index.html` + `main.js` + `style.css`: served by `deno task dev` or any static host;
 * - `playground.html`: the same page as one self-contained file (styles, script and examples inlined).
 *
 * Example programs from ../examples are embedded in both.
 */

const root = new URL("../", import.meta.url);
const path = (p: string) => new URL(p, root).pathname;
const dist = path("dist/");

await Deno.mkdir(dist, { recursive: true });

const bundle = await new Deno.Command(Deno.execPath(), {
  args: ["bundle", "--quiet", "--platform", "browser", "--minify", "--output", `${dist}main.js`, path("ui/main.ts")],
  stdout: "inherit",
  stderr: "inherit",
}).output();
if (!bundle.success) Deno.exit(1);

const examples: Record<string, string> = {};
for await (const entry of Deno.readDir(path("../examples/"))) {
  // The benchmark runs for seconds; it is not a good first example to click.
  if (entry.isFile && entry.name.endsWith(".pseudo") && entry.name !== "bench.pseudo") {
    examples[entry.name] = await Deno.readTextFile(path(`../examples/${entry.name}`));
  }
}
const sorted = Object.fromEntries(Object.entries(examples).sort(([a], [b]) => a.localeCompare(b)));
// `<` is escaped so no example can close the script element early.
const examplesScript = `<script>window.PSEUDO_EXAMPLES = ${
  JSON.stringify(sorted).replaceAll("<", "\\u003c")
};</script>`;

const page = await Deno.readTextFile(path("ui/page.html"));
const css = await Deno.readTextFile(path("ui/style.css"));
const js = await Deno.readTextFile(`${dist}main.js`);

await Deno.copyFile(path("ui/style.css"), `${dist}style.css`);
await Deno.writeTextFile(
  `${dist}index.html`,
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    page.replace("<!--STYLE-->", `<link rel="stylesheet" href="style.css">`).replace(
      '<div class="app">',
      '</head>\n<body>\n<div class="app">',
    ) +
    `${examplesScript}\n<script type="module" src="main.js"></script>\n</body>\n</html>\n`,
);
await Deno.writeTextFile(
  `${dist}playground.html`,
  page.replace("<!--STYLE-->", `<style>\n${css}</style>`) +
    `${examplesScript}\n<script type="module">\n${js.replaceAll("</script", "<\\/script")}</script>\n`,
);

const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
console.log(
  `dist/main.js ${kb(js.length)}, dist/playground.html ${kb((await Deno.stat(`${dist}playground.html`)).size)}`,
);
