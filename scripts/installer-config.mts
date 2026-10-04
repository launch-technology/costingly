/**
 * How the desktop app is packaged for Windows — shared by the installer build
 * and the packaged-app check, so both package exactly the same thing.
 *
 * Every electron-builder setting is here, and the reasons the non-obvious ones
 * are what they are:
 *
 *   asar: false          The app's files are installed as ordinary files, not
 *                        packed into one archive. The database engine is a set
 *                        of real programs that Windows has to be able to run
 *                        and that read their own data files; neither works
 *                        from inside an archive. Plain files also mean the
 *                        code that finds the migrations and the engine works
 *                        exactly as it does from a source folder.
 *
 *   extraMetadata        The entry point and display name are set for the
 *                        packaged app only. package.json itself gets neither:
 *                        it describes the whole repository, of which the
 *                        desktop app is one interface.
 *
 *   output               build/installer/, beside the .mcpb: build/ is where
 *                        everything that ships is written. Not dist/, which is
 *                        what gets packaged and is wiped by every compile.
 *
 *   electronDist         Use the Electron already in node_modules rather than
 *                        downloading a second copy.
 *
 *   npmRebuild: false    Nothing here has native code to rebuild.
 *
 *   one-click, per-user  No administrator prompt and no questions. The program
 *                        goes under the user's own profile, like their data.
 *
 *   deleteAppDataOnUninstall: false
 *                        Uninstalling removes the program and nothing else.
 *                        What to do with the user's data is a later story's
 *                        question, and it will ask.
 *
 * Unsigned: Windows will warn about an unknown publisher. Signing is out of
 * scope for now and the README says so.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import type { Configuration } from "electron-builder";

import { placeholderPixels } from "../src/apps/desktop/main/shell/placeholder-pixels.js";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const OUT = join(ROOT, "build", "installer");
/** What electron-builder names the packaged-but-not-installed app's folder. */
export const UNPACKED = join(OUT, "win-unpacked");
export const EXECUTABLE = "Costingly.exe";

const ICON = join(OUT, "icon.ico");

export function installerConfig(): Configuration {
  return {
    appId: "technology.launch.costingly",
    productName: "Costingly",
    directories: { output: OUT, buildResources: join(ROOT, "installer") },
    // productName is repeated here because Electron reads the app's name from
    // the packaged package.json, and would otherwise report "costingly".
    extraMetadata: { main: "dist/apps/desktop/main/main.js", productName: "Costingly" },

    // Production node_modules are added by electron-builder itself; these are
    // the repository's own files the app needs at runtime.
    files: ["dist/**/*", "migrations/**/*", "public/**/*", "package.json", "LICENSE", "NOTICE"],
    asar: false,
    npmRebuild: false,
    electronDist: join(ROOT, "node_modules", "electron", "dist"),
    publish: null,

    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      icon: ICON,
    },
    nsis: {
      oneClick: true,
      perMachine: false,
      runAfterFinish: true,
      createStartMenuShortcut: true,
      createDesktopShortcut: false,
      shortcutName: "Costingly",
      deleteAppDataOnUninstall: false,
      artifactName: "Costingly-Setup-${version}.${ext}",
      include: join(ROOT, "installer", "installer.nsh"),
    },
  };
}

/**
 * Write the placeholder icon as an .ico, and return where.
 *
 * Generated rather than committed: it is the same drawing the running app
 * uses, so there is one definition of the icon and no binary in the
 * repository. An .ico is a small header around an image; modern Windows
 * accepts a PNG inside, which is what this writes, at the 256 pixels the
 * Start menu and installed-apps list ask for.
 */
export async function writeIcon(): Promise<string> {
  const size = 256;
  const image = png(size, placeholderPixels(size));

  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header.writeUInt8(0, 6); // width: 0 means 256
  header.writeUInt8(0, 7); // height: 0 means 256
  header.writeUInt8(0, 8); // no palette
  header.writeUInt8(0, 9); // reserved
  header.writeUInt16LE(1, 10); // colour planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(image.length, 14);
  header.writeUInt32LE(header.length, 18); // image starts after the header

  await mkdir(OUT, { recursive: true });
  await writeFile(ICON, Buffer.concat([header, image]));
  return ICON;
}

/** Encode RGBA pixels as a PNG. */
function png(size: number, rgba: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bits per channel
  header.writeUInt8(6, 9); // colour type: RGBA
  // compression, filter and interlace stay 0

  // Each row is prefixed with its filter type; 0 is "none".
  const stride = size * 4;
  const rows = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    rows.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
