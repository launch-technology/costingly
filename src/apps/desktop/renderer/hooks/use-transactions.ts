/**
 * The Transactions screen's behaviour: what is being asked for, what came
 * back, and when to ask again.
 *
 * THE FILTERS LIVE HERE; WHAT THEY MATCH IS DECIDED ELSEWHERE. This holds an
 * account, two dates, some text and a count of how many to show, and sends
 * them as they are. Which transactions match, in what order, is the main
 * process's answer.
 *
 * WHEN IT ASKS AGAIN
 *
 *   a filter changes     and the list starts over from the newest
 *   typing pauses        search waits a moment after the last keystroke, so a
 *                        word is one question and not one per letter
 *   Show more            asks for the same thing with a larger count — the
 *                        whole list is re-read from the top, so nothing is
 *                        skipped or repeated if new transactions arrived
 *   the window returns   or a sync finishes: what is shown may be out of date
 *
 * WHAT IS ON SCREEN STAYS WHILE THE NEXT ANSWER LOADS. Only the very first
 * load shows "loading"; after that the rows stay put until replaced, and an
 * answer overtaken by a later question is dropped.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { TransactionsQuery, TransactionsView } from "../../bridge/contract.js";
import { call, on } from "../api/client.js";

/** How many transactions a first look shows, and how many each "Show more" adds. */
const PAGE = 100;
/** How long typing must pause before the search runs. */
const TYPING_PAUSE_MS = 300;

export interface TransactionFilters {
  accountId: string;
  from: string;
  to: string;
  /** The search box as typed — ahead of what has been searched for while typing. */
  text: string;
}

const NO_FILTERS: TransactionFilters = { accountId: "", from: "", to: "", text: "" };

export type TransactionsState = { phase: "loading" } | { phase: "loaded"; view: TransactionsView };

export interface Transactions {
  state: TransactionsState;
  filters: TransactionFilters;
  /** True when any filter is set. */
  filtered: boolean;
  /** True while an answer is on its way and an older one is still shown. */
  refreshing: boolean;
  setFilter(change: Partial<TransactionFilters>): void;
  clearFilters(): void;
  showMore(): void;
  reload(): void;
}

export function useTransactions(): Transactions {
  const [filters, setFilters] = useState<TransactionFilters>(NO_FILTERS);
  // The text actually searched for: `filters.text` once typing has paused.
  const [searchedText, setSearchedText] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [state, setState] = useState<TransactionsState>({ phase: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  // Which question is current: an earlier answer must not replace a later one.
  const asked = useRef(0);

  useEffect(() => {
    if (filters.text === searchedText) return;
    const waiting = setTimeout(() => setSearchedText(filters.text), TYPING_PAUSE_MS);
    return () => clearTimeout(waiting);
  }, [filters.text, searchedText]);

  const load = useCallback(() => {
    const mine = ++asked.current;
    const query: TransactionsQuery = {
      accountId: filters.accountId,
      from: filters.from,
      to: filters.to,
      text: searchedText,
      limit,
    };
    const settle = (view: TransactionsView): void => {
      if (asked.current !== mine) return;
      setState({ phase: "loaded", view });
      setRefreshing(false);
    };

    setRefreshing(true);
    call("transactions.find", query).then(settle, (error: unknown) =>
      settle({
        state: "failed",
        problem: {
          cause: `The transactions could not be read: ${error instanceof Error ? error.message : String(error)}`,
          nextStep: "Check the Status screen, then try again.",
        },
      }),
    );
  }, [filters.accountId, filters.from, filters.to, searchedText, limit]);

  // Asks whenever the question changes — `load` is rebuilt exactly then.
  useEffect(load, [load]);

  // The latest `load`, for listeners that must not re-subscribe on every change.
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    const stopShown = on("window.shown", () => latest.current());
    const stopSync = on("sync.changed", (sync) => {
      if (sync.state === "finished") latest.current();
    });
    return () => {
      stopShown();
      stopSync();
    };
  }, []);

  const setFilter = useCallback((change: Partial<TransactionFilters>) => {
    setFilters((previous) => ({ ...previous, ...change }));
    // A different question starts from the newest again.
    setLimit(PAGE);
  }, []);

  const clearFilters = useCallback(() => {
    setFilters(NO_FILTERS);
    setSearchedText("");
    setLimit(PAGE);
  }, []);

  const showMore = useCallback(() => setLimit((shown) => shown + PAGE), []);

  return {
    state,
    filters,
    filtered: filters.accountId !== "" || filters.from !== "" || filters.to !== "" || filters.text !== "",
    refreshing,
    setFilter,
    clearFilters,
    showMore,
    reload: load,
  };
}
