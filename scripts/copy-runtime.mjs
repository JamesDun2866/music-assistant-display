import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../dist/server/server/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL("../src/server/native-cec.py", import.meta.url), new URL("native-cec.py", destination));
