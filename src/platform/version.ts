/**
 * The one rule about versions that two programs share.
 *
 * The desktop app and the Claude Desktop extension are built from the same
 * version number. A different MAJOR version means the two no longer agree
 * about what passes between them; anything less is fine. The extension
 * applies the rule before relaying (apps/mcpb), and the app applies it to say
 * on its Claude Desktop screen whether the extension that spoke to it needs
 * reinstalling. Both import it from here so neither imports the other.
 */

/** The leading number of a version, or undefined when there is none to read. */
export function majorOf(version: string): number | undefined {
  const match = /^(\d+)\./.exec(version.trim());
  return match === null ? undefined : Number(match[1]);
}

/**
 * Same major version, or a version that cannot be read. Only a major that is
 * clearly different is refused: an odd label is not a reason to stop working.
 */
export function compatible(otherVersion: string | undefined, ownVersion: string): boolean {
  if (otherVersion === undefined) return true;
  const other = majorOf(otherVersion);
  const own = majorOf(ownVersion);
  return other === undefined || own === undefined || other === own;
}
