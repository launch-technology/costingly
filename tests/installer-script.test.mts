/**
 * The installer script's uninstall behaviour, read as text.
 *
 * The real uninstaller cannot be run by a test: it deletes the data folder of
 * whoever runs it, and resolves that folder from Windows, not from anything a
 * test could redirect. So what can be proven automatically is that the script
 * says what it must, where it must:
 *
 *   1. The data warning exists, only in the uninstaller, after the running
 *      check, and only when neither upgrading nor silent
 *   2. It names what is lost and the Plaid consequence, and Cancel quits
 *   3. The delete is gated on the flag the warning sets, and nowhere else
 *      is the data folder touched
 *   4. A folder that would not delete is shown to the user
 *   5. The start-at-sign-in registration is still removed, and still kept
 *      on an upgrade
 *
 * Every platform: it reads a file. The uninstall itself is verified by hand
 * (Story 15's Verification Steps).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const script = readFileSync(join(ROOT, "installer", "installer.nsh"), "utf8");

const out: string[] = [];
let fail = 0;
function ok(condition: boolean, what: string): void {
  if (condition) out.push(`  ok    ${what}`);
  else {
    out.push(`  FAIL  ${what}`);
    fail++;
  }
}

/** The text of one macro, from its definition to its end. */
function macro(name: string): string {
  const match = new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`).exec(script);
  return match?.[1] ?? "";
}

const check = macro("customCheckAppRunning");
const uninstall = macro("customUnInstall");
const DATA_FOLDER = "$LOCALAPPDATA\\costingly";

// 1. Where the warning lives --------------------------------------------------
ok(check.length > 0 && uninstall.length > 0, "the running-check and uninstall macros are defined");
const guardStart = check.indexOf("!ifdef __UNINSTALL__");
const guardEnd = check.indexOf("!endif", guardStart);
ok(guardStart > 0 && guardEnd > guardStart, "the warning sits under the uninstaller-only compile guard");
const warning = check.slice(guardStart, guardEnd);
ok(check.indexOf("costingly_check_running:") < guardStart, "and comes after the running check, not before it");
ok(/\$\{ifNot\} \$\{isUpdated\}/.test(warning), "skipped when the uninstaller runs for an upgrade");
ok(/\$\{andIfNot\} \$\{Silent\}/.test(warning), "and when it was started silent");
ok(/StrCpy \$costinglyDeleteData "0"/.test(warning), "the flag starts off");

// 2. What the warning says and does ------------------------------------------
const box = /MessageBox MB_OKCANCEL[^\n]*/.exec(warning)?.[0] ?? "";
ok(box.length > 0, "the warning is an OK/Cancel message box");
ok(/database of transactions/.test(box) && /Plaid keys/.test(box), "it names the database and the Plaid keys as what is deleted");
ok(/stay connected at Plaid/.test(box) && /unlink each bank first/.test(box), "and says linked banks stay at Plaid unless unlinked first");
ok(/\/SD IDCANCEL/.test(box), "the silent default is Cancel");
const afterBox = warning.slice(warning.indexOf(box) + box.length);
ok(/^\s*Quit\b/m.test(afterBox), "Cancel falls through to Quit: nothing is touched");
ok(/IDOK costingly_delete_data/.test(box) && /costingly_delete_data:\s*\n\s*StrCpy \$costinglyDeleteData "1"/.test(afterBox), "OK jumps to setting the flag");
ok(!/RMDir|Delete /.test(check), "the running-check macro deletes nothing itself");

// 3. The delete, gated ------------------------------------------------------
const gateStart = uninstall.indexOf('${if} $costinglyDeleteData == "1"');
ok(gateStart > 0, "the uninstall step tests the flag");
const gated = uninstall.slice(gateStart);
ok(gated.includes(`RMDir /r "${DATA_FOLDER}"`), `and deletes ${DATA_FOLDER} recursively inside that test`);
const mentions = script.split(DATA_FOLDER).length - 1;
const gatedMentions = gated.split(DATA_FOLDER).length - 1;
ok(mentions === gatedMentions, `every mention of ${DATA_FOLDER} is inside the gated block (${mentions})`);
ok(!/RMDir \/r "\$LOCALAPPDATA\\costingly-updater"|RMDir \/r "\$LOCALAPPDATA"/.test(script), "nothing else under LOCALAPPDATA is deleted recursively");

// 4. What is left is shown --------------------------------------------------
ok(gated.includes(`\${if} \${FileExists} "${DATA_FOLDER}\\*.*"`) && gated.includes(`ExecShell "open" "${DATA_FOLDER}"`), "a folder that would not delete is opened for the user");

// 5. The registration, as before -------------------------------------------
ok(/\$\{ifNot\} \$\{isUpdated\}\s*\n\s*DeleteRegValue HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Run" "Costingly"/.test(uninstall), "the start-at-sign-in value is removed, except on an upgrade");

ok(script.split("Var /GLOBAL costinglyDeleteData").length === 2 && /Var \/GLOBAL costinglyDeleteData/.test(warning), "the flag is declared once, inside the uninstaller-only guard (the installer is compiled without it)");

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
