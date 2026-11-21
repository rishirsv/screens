import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packages = fileURLToPath(new URL("../", import.meta.url));
const declaration = /(?:^|[;{}])\s*((?:padding|margin)(?:-[a-z-]+)?|(?:row-|column-)?gap)\s*:\s*([^;{}]*)/gim;
const dimension = /(?<![\w-])([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)(?:[a-z]+|%)/gi;

for (const file of globSync("**/*.css", { cwd: packages, exclude: ["**/node_modules/**"] })) {
  const css = readFileSync(join(packages, file), "utf8");
  // Mask strings and comments so they cannot look like declarations. Keep line numbers.
  const source = css.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, (match) => match.replace(/[^\n]/g, " "));
  for (const match of source.matchAll(declaration)) {
    const [, property, value] = match;
    if (![...value.matchAll(dimension)].some(([, number]) => Number(number) !== 0)) continue;
    const line = source.slice(0, match.index + match[0].indexOf(property)).split("\n").length;
    console.error(`packages/${file}:${line}: use spacing tokens for ${property}: ${value.trim()}`);
    process.exitCode = 1;
  }
}
