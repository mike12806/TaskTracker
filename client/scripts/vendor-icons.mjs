#!/usr/bin/env node
/**
 * Writes `src/icons.tsx`: the Material icons the client uses, copied out of
 * @mui/icons-material so that the package itself is not a dependency.
 *
 * The package is some 43,000 files — about two thirds of everything `npm ci`
 * writes into node_modules — for a few dozen icons, and every CI job and
 * deploy paid for unpacking all of it. Each icon is nothing but SVG path data
 * handed to `createSvgIcon`, so the copy is that data and the same call.
 *
 * Keeping it current: releases add icons rather than redraw them. Every icon
 * in TaskTracker and BabyTracker came out byte-for-byte the same from 6.0.0
 * (August 2024) as from 9.5.0, and before 6.0.0 the only change was a
 * re-minification that dropped redundant closing `z`s. What can change is
 * `createSvgIcon` and the `SvgIcon` it renders, and those come from
 * @mui/material, which stays a dependency, so a Material upgrade is still
 * type-checked and tested against every icon. The icons are taken from the
 * @mui/icons-material release matching @mui/material's version (the two are
 * published together), or from `--version`.
 *
 * Which icons: every `<Name>Icon` imported from `src/icons` anywhere under
 * `src/`. To use a new one, import it from there and run this; an icon that
 * nothing imports any more is dropped on the next run. Needs the npm registry:
 * it downloads the package tarball and reads only the icons it needs.
 *
 *   npm run icons -w client
 *   npm run icons -w client -- --version 9.5.0
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const clientDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(clientDir, "src");
const iconsModule = join(srcDir, "icons");
const outFile = join(srcDir, "icons.tsx");

function fail(message) {
  console.error(`vendor-icons: ${message}`);
  process.exit(1);
}

function packageVersion() {
  const flag = process.argv.indexOf("--version");
  if (flag !== -1) {
    const value = process.argv[flag + 1];
    if (!value) fail("--version needs a value");
    return value;
  }
  const pkg = JSON.parse(readFileSync(join(clientDir, "package.json"), "utf8"));
  const version = pkg.dependencies?.["@mui/material"];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    fail(`@mui/material is not pinned to an exact version (${version}); pass --version`);
  }
  return version;
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && path !== outFile ? [path] : [];
  });
}

/** Icon names (`Add` for `AddIcon`) imported from src/icons, sorted. */
function usedIcons() {
  const names = new Set();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const file of sourceFiles(srcDir)) {
    for (const [, specifiers, from] of readFileSync(file, "utf8").matchAll(importRe)) {
      if (!from.startsWith(".") || resolve(dirname(file), from) !== iconsModule) continue;
      for (const specifier of specifiers.split(",").map((s) => s.trim()).filter(Boolean)) {
        const imported = specifier.split(/\s+as\s+/)[0];
        const match = /^([A-Z][A-Za-z0-9]*)Icon$/.exec(imported);
        if (!match) fail(`${relative(clientDir, file)} imports "${imported}"; icons are named <Name>Icon`);
        names.add(match[1]);
      }
    }
  }
  if (names.size === 0) fail("nothing under src/ imports from src/icons");
  return [...names].sort();
}

/** Download the package tarball and unpack just the CommonJS module of each icon. */
function extractIcons(version, names, workDir) {
  const tarball = execFileSync(
    "npm",
    ["pack", `@mui/icons-material@${version}`, "--pack-destination", workDir, "--silent"],
    { encoding: "utf8" },
  ).trim().split("\n").pop();
  const members = names.map((name) => `package/${name}.js`);
  try {
    execFileSync("tar", ["-xzf", join(workDir, tarball), "-C", workDir, ...members], { stdio: "pipe" });
  } catch {
    // tar names a missing member as an error; report them all, by icon name.
  }
  const missing = names.filter((name) => !existsSync(join(workDir, "package", `${name}.js`)));
  if (missing.length) fail(`not in @mui/icons-material@${version}: ${missing.join(", ")}`);
}

/**
 * Run an icon's CommonJS module against stand-ins for React's JSX runtime and
 * createSvgIcon, which turns it into data: the element tree and the name.
 */
function readIcon(file) {
  const element = (type, props, key) => ({ type, props, key });
  // Babel's helper is both the function and its own `default`; releases differ
  // in which one they call.
  const interopRequireDefault = (m) => ({ default: m });
  interopRequireDefault.default = interopRequireDefault;
  const modules = {
    "@babel/runtime/helpers/interopRequireDefault": interopRequireDefault,
    "./utils/createSvgIcon": (children, name) => ({ children, name }),
    "react/jsx-runtime": { jsx: element, jsxs: element },
  };
  const require = (id) => {
    if (!(id in modules)) fail(`${file} requires "${id}"; the package's module format has changed`);
    return modules[id];
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", readFileSync(file, "utf8"))(require, module.exports, module);
  return module.exports.default;
}

function attribute(name, value) {
  if (typeof value === "string" && /^[^"\\{}<>&]*$/.test(value)) return `${name}="${value}"`;
  return `${name}={${JSON.stringify(value)}}`;
}

function jsx(node, indent) {
  if (Array.isArray(node)) return node.map((child) => jsx(child, indent)).join("\n");
  const { children, ...props } = node.props;
  const attributes = [
    ...(node.key == null ? [] : [attribute("key", node.key)]),
    ...Object.entries(props).map(([name, value]) => attribute(name, value)),
  ];
  const open = `${indent}<${node.type}${attributes.map((a) => ` ${a}`).join("")}`;
  if (children == null) return `${open} />`;
  return `${open}>\n${jsx(children, `${indent}  `)}\n${indent}</${node.type}>`;
}

function render(version, icons) {
  const body = icons.map(({ exportName, name, children }) => {
    const element = Array.isArray(children)
      ? `[\n${children.map((child) => `${jsx(child, "    ")},`).join("\n")}\n  ]`
      : jsx(children, "  ").trimStart();
    return `export const ${exportName}Icon = /*#__PURE__*/ createSvgIcon(\n  ${element},\n  "${name}",\n);\n`;
  });
  return [
    `// Generated by scripts/vendor-icons.mjs from @mui/icons-material@${version}. Do not edit.`,
    "// To use another icon, import <Name>Icon from here and run `npm run icons -w client`.",
    'import { createSvgIcon } from "@mui/material/SvgIcon";',
    "",
    body.join("\n"),
  ].join("\n");
}

const version = packageVersion();
const names = usedIcons();
const workDir = mkdtempSync(join(tmpdir(), "vendor-icons-"));
try {
  extractIcons(version, names, workDir);
  const icons = names.map((exportName) => ({
    exportName,
    ...readIcon(join(workDir, "package", `${exportName}.js`)),
  }));
  writeFileSync(outFile, render(version, icons));
  console.log(`Wrote ${icons.length} icons from @mui/icons-material@${version} to ${relative(clientDir, outFile)}`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
