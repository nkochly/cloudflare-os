// Holds this repo's GLOSSARY.md shared core to the Trifecta master in
// wiki_mcp/GLOSSARY.md. Written by wiki_mcp's tools/glossary-sync.mjs; never
// edit the core or this digest here. Change the core in wiki_mcp and run
// `npm run glossary:sync` there.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GLOSSARY_CORE_SHA256 = "0178df9256d493aa9704c596ea8caa6b3fa22efd08bace4aebe0911bbd97cb25";
const START = "<!-- glossary-core:start -->";
const END = "<!-- glossary-core:end -->";

const file = resolve(dirname(fileURLToPath(import.meta.url)), "..", "GLOSSARY.md");
const text = readFileSync(file, "utf8");
const a = text.indexOf(START);
const b = text.indexOf(END);
if (a < 0 || b < a) {
  console.error(`${file} has no shared core between ${START} and ${END}.`);
  process.exit(1);
}
const got = createHash("sha256").update(text.slice(a, b + END.length), "utf8").digest("hex");
if (got !== GLOSSARY_CORE_SHA256) {
  console.error(
    `GLOSSARY.md's shared core differs from the Trifecta master (sha256 ${got}, expected ${GLOSSARY_CORE_SHA256}). ` +
      "Change the core in wiki_mcp/GLOSSARY.md and run `npm run glossary:sync` there; never edit it in a copy.",
  );
  process.exit(1);
}
