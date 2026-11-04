import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");

const rules = [
  { prefix: "packages/core/", allow: [/^\.{1,2}\//, /^zod$/, /^vitest$/] },
  {
    prefix: "packages/detectors-keyword/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-join/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-rate/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-link/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-blocklist/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-llm/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-regex/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-forward/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-folder/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-media/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-notice/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-script/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-sender/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-story/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-location/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-giveaway/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-call/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-title/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-community/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-shared-chat/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-photo/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-background/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-gift/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-pin/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-giveaway-notice/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-boost/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-forum/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-autodelete/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-price/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-post/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-checklist/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-call-invite/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-owner/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/detectors-proximity/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/actions/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/adapters-memory/",
    allow: [/^\.{1,2}\//, /^@tasb\/core(\/.*)?$/, /^vitest$/],
  },
  {
    prefix: "packages/adapters-cloudflare/",
    allow: [/^\.{1,2}\//, /^@tasb\/core(\/.*)?$/, /^vitest$/],
    testAllow: [/^node:/],
  },
  {
    prefix: "packages/platform-telegram/",
    allow: [/^\.{1,2}\//, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "packages/sdk/",
    allow: [/^\.{1,2}\//, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "apps/worker/",
    allow: [
      /^\.{1,2}\//,
      /^hono$/,
      /^cloudflare:workers$/,
      /^vitest$/,
      /^@tasb\/core$/,
      /^@tasb\/platform-telegram$/,
      /^@tasb\/detector-keyword$/,
      /^@tasb\/detector-join$/,
      /^@tasb\/detector-bot$/,
      /^@tasb\/detector-contact$/,
      /^@tasb\/detector-via$/,
      /^@tasb\/detector-folder$/,
      /^@tasb\/detector-media$/,
      /^@tasb\/detector-notice$/,
      /^@tasb\/detector-script$/,
      /^@tasb\/detector-sender$/,
      /^@tasb\/detector-story$/,
      /^@tasb\/detector-location$/,
      /^@tasb\/detector-giveaway$/,
      /^@tasb\/detector-call$/,
      /^@tasb\/detector-title$/,
      /^@tasb\/detector-community$/,
      /^@tasb\/detector-shared-chat$/,
      /^@tasb\/detector-photo$/,
      /^@tasb\/detector-background$/,
      /^@tasb\/detector-gift$/,
      /^@tasb\/detector-pin$/,
      /^@tasb\/detector-giveaway-notice$/,
      /^@tasb\/detector-boost$/,
      /^@tasb\/detector-forum$/,
      /^@tasb\/detector-autodelete$/,
      /^@tasb\/detector-price$/,
      /^@tasb\/detector-post$/,
      /^@tasb\/detector-checklist$/,
      /^@tasb\/detector-call-invite$/,
      /^@tasb\/detector-owner$/,
      /^@tasb\/detector-proximity$/,
      /^@tasb\/detector-rate$/,
      /^@tasb\/detector-link$/,
      /^@tasb\/detector-blocklist$/,
      /^@tasb\/detector-llm$/,
      /^@tasb\/detector-regex$/,
      /^@tasb\/detector-forward$/,
      /^@tasb\/actions$/,
      /^@tasb\/adapter-memory$/,
      /^@tasb\/adapter-cloudflare$/,
      /^@tasb\/cloud$/,
    ],
  },
  {
    prefix: "apps/cloud/",
    allow: [/^\.{1,2}\//, /^zod$/, /^@tasb\/core$/, /^node:/, /^vitest$/],
  },
  {
    prefix: "examples/",
    allow: [/^\.{1,2}\//, /^@tasb\//, /^node:/, /^vitest$/],
  },
  {
    prefix: "evals/",
    allow: [
      /^\.{1,2}\//,
      /^@tasb\/core$/,
      /^@tasb\/detector-keyword$/,
      /^@tasb\/detector-rate$/,
      /^@tasb\/detector-link$/,
      /^@tasb\/detector-blocklist$/,
      /^@tasb\/detector-llm$/,
      /^@tasb\/detector-regex$/,
      /^@tasb\/detector-forward$/,
      /^@tasb\/detector-bot$/,
      /^@tasb\/detector-contact$/,
      /^@tasb\/detector-via$/,
      /^@tasb\/detector-folder$/,
      /^@tasb\/detector-media$/,
      /^@tasb\/detector-notice$/,
      /^@tasb\/detector-script$/,
      /^@tasb\/detector-sender$/,
      /^@tasb\/detector-story$/,
      /^@tasb\/detector-location$/,
      /^@tasb\/detector-giveaway$/,
      /^@tasb\/detector-call$/,
      /^@tasb\/detector-title$/,
      /^@tasb\/detector-community$/,
      /^@tasb\/detector-shared-chat$/,
      /^@tasb\/detector-photo$/,
      /^@tasb\/detector-background$/,
      /^@tasb\/detector-gift$/,
      /^@tasb\/detector-pin$/,
      /^@tasb\/detector-giveaway-notice$/,
      /^@tasb\/detector-boost$/,
      /^@tasb\/detector-forum$/,
      /^@tasb\/detector-autodelete$/,
      /^@tasb\/detector-price$/,
      /^@tasb\/detector-post$/,
      /^@tasb\/detector-checklist$/,
      /^@tasb\/detector-call-invite$/,
      /^@tasb\/detector-owner$/,
      /^@tasb\/detector-proximity$/,
      /^node:/,
      /^vitest$/,
    ],
  },
];

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
const dynamicPattern = /import\(\s*["']([^"']+)["']\s*\)/g;

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

async function walk(directory, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "coverage" ||
      entry.name === ".wrangler"
    ) {
      continue;
    }
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
      continue;
    }
    if (entry.name === "vitest.config.ts") {
      continue;
    }
    if (
      entry.name.endsWith(".ts") ||
      entry.name.endsWith(".tsx") ||
      entry.name.endsWith(".mjs")
    ) {
      files.push(full);
    }
  }
}

function specifiers(source) {
  const cleaned = stripComments(source);
  const found = [];
  for (const pattern of [importPattern, dynamicPattern]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(cleaned);
    while (match) {
      const value = match[1];
      if (value) {
        found.push(value);
      }
      match = pattern.exec(cleaned);
    }
  }
  return found;
}

const files = [];
for (const folder of ["packages", "apps", "examples", "evals"]) {
  await walk(join(root, folder), files);
}

const violations = [];
for (const file of files) {
  const rel = relative(root, file).replaceAll("\\", "/");
  const rule = rules.find((item) => rel.startsWith(item.prefix));
  if (!rule) {
    continue;
  }
  const source = await readFile(file, "utf8");
  const allow = rel.endsWith(".test.ts")
    ? [...rule.allow, ...(rule.testAllow ?? [])]
    : rule.allow;
  for (const specifier of specifiers(source)) {
    if (!allow.some((pattern) => pattern.test(specifier))) {
      violations.push(`${rel}: forbidden import "${specifier}"`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(`boundaries ok (${files.length} files)`);
