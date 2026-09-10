/**
 * Two-phase confirmation for tools that destroy something.
 *
 * A destructive tool takes two calls: the first reports what would be lost and
 * mints a token, the second spends that token to go through with it. The point
 * is not to stop the model — it holds the token — but to force the impact
 * statement into the transcript where a human can see it and stop, and to make
 * a single injected "delete X" instruction return a preview instead of a
 * deletion.
 *
 * Tokens are random, bound to one subject, single-use, and short-lived. The
 * subject is whatever identifies the thing at risk; this store never interprets
 * it, so it is an item id here and could be anything elsewhere.
 */

import { randomBytes } from "node:crypto";

export class ConfirmationStore {

    private _pending = new Map<string, { subject: string; expiresAt: number }>();
    private readonly _ttlMs: number;

    /**
     * @param ttlMs How long a token stays spendable. Long enough for the model
     * to put the numbers to the user and get an answer, short enough that a
     * token cannot sit waiting to be spent in a conversation that has moved on.
     */
    constructor(ttlMs: number) {
        this._ttlMs = ttlMs;
    }

    /** Mint a token for `subject`. Nothing is destroyed by calling this. */
    issue(subject: string): string {
        this._sweep();
        const token = randomBytes(9).toString("base64url");
        this._pending.set(token, { subject, expiresAt: Date.now() + this._ttlMs });
        return token;
    }

    /**
     * Spend a token. True only if it exists, has not expired, and was issued
     * for this exact subject — a token for one bank cannot delete another.
     *
     * Spending happens BEFORE the caller destroys anything, so a failure
     * part-way through cannot leave a token behind that would delete twice.
     */
    spend(token: string, subject: string): boolean {
        this._sweep();
        const pending = this._pending.get(token);
        if (pending === undefined || pending.subject !== subject) return false;
        this._pending.delete(token);
        return true;
    }

    /**
     * Drop expired tokens. Called on every use rather than on a timer: the map
     * only grows while someone is midway through a confirmation, so there is
     * never enough in it to be worth a scheduled sweep.
     */
    private _sweep(): void {
        const now = Date.now();
        for (const [key, pending] of this._pending) {
            if (pending.expiresAt <= now) this._pending.delete(key);
        }
    }
}
