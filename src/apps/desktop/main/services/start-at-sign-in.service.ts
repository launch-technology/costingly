/**
 * Starting Costingly when the user signs in to Windows.
 *
 * WINDOWS HOLDS THE SETTING, NOT THE APP. Whether Costingly starts at sign-in
 * is a registration Windows keeps, and this asks Windows every time rather
 * than remembering an answer: a switch that said "on" while Windows had
 * forgotten would be worse than no switch. The same goes for changing it —
 * after a write, the registration is read back, and what is reported is what
 * Windows has, not what was asked for.
 *
 * Off by default. The app never registers itself without being asked.
 *
 * How the registration is read and written is Electron's, handed in from
 * shell/start-at-sign-in.ts; this file is the decisions around it and knows
 * no Electron. Never throws.
 */

export interface StartAtSignInDependencies {
  /** Is Costingly registered to start at sign-in? Asks Windows. */
  registered(): boolean;
  /** Register, or unregister. May throw if Windows refuses. */
  register(on: boolean): void;
  /** A safe one-line description of any error — never the error object. */
  describeError(error: unknown): string;
}

export type StartAtSignInChange = { changed: true; on: boolean } | { changed: false; on: boolean; reason: string };

export class StartAtSignInService {
  constructor(private readonly deps: StartAtSignInDependencies) {}

  isOn(): boolean {
    try {
      return this.deps.registered();
    } catch {
      // A registration that cannot be read is, for every purpose here, off.
      return false;
    }
  }

  /** Ask for on or off, and report what Windows has afterwards. */
  set(on: boolean): StartAtSignInChange {
    try {
      this.deps.register(on);
      const now = this.isOn();
      return now === on
        ? { changed: true, on: now }
        : { changed: false, on: now, reason: "Windows did not keep the change." };
    } catch (error) {
      return { changed: false, on: this.isOn(), reason: this.deps.describeError(error) };
    }
  }
}
