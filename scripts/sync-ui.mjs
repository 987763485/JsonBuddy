import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const sourcePath = path.join(root, "design", "prototype.html");
const outputDir = path.join(root, "ui");
const outputPath = path.join(outputDir, "index.html");

const source = fs.readFileSync(sourcePath, "utf8");
const injection = '\n    <script type="module" src="/bridge.ts"></script>\n';

const bodyIndex = source.lastIndexOf("</body>");
if (bodyIndex < 0) {
  throw new Error("prototype.html has no closing body tag");
}

const output = `${source.slice(0, bodyIndex)}${injection}${source.slice(bodyIndex)}`;
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputPath, output);
console.log(`synced ${path.relative(root, sourcePath)} -> ${path.relative(root, outputPath)}`);
