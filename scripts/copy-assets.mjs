// Copies static dashboard assets into dist so the built server can serve them.
import { cp, mkdir } from "node:fs/promises";

const src = "src/dashboard/public";
const dest = "dist/src/dashboard/public";

await mkdir("dist/src/dashboard", { recursive: true });
await cp(src, dest, { recursive: true });
console.log(`Copied ${src} -> ${dest}`);
