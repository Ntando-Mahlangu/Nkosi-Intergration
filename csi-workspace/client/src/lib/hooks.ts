import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

type Query = Record<string, string | number | boolean | null | undefined>;

/**
 * Load data from the API. Pass path = null to skip. Re-runs when path or query change.
 * Returns { data, error, loading, reload, setData }.
 */
export function useApi<T>(path: string | null, query?: Query) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const key = path ? path + JSON.stringify(query ?? {}) : null;
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await api.get<T>(path, query);
      if (my === seq.current) setData(d);
    } catch (e) {
      if (my === seq.current) setError(e instanceof ApiError ? e : new ApiError(0, "Could not reach the server."));
    } finally {
      if (my === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}

/** Local calendar date (YYYY-MM-DD) in the browser's timezone — send as ?today= to the API. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Form state helper with server-side field errors. */
export function useForm<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const set = <K extends keyof T>(k: K, v: T[K]) => {
    setValues((s) => ({ ...s, [k]: v }));
    setErrors((e) => {
      const n = { ...e };
      delete n[k as string];
      return n;
    });
  };
  async function submit<R>(fn: (v: T) => Promise<R>, validate?: (v: T) => Record<string, string>): Promise<R | undefined> {
    setFormError("");
    const local = validate ? validate(values) : {};
    if (Object.keys(local).length) {
      setErrors(local);
      setFormError("Please check the highlighted fields.");
      return undefined;
    }
    setSubmitting(true);
    try {
      return await fn(values);
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fields);
        setFormError(e.message);
      } else setFormError("Something went wrong. Please try again.");
      return undefined;
    } finally {
      setSubmitting(false);
    }
  }
  return { values, set, setValues, errors, setErrors, formError, setFormError, submitting, submit };
}
