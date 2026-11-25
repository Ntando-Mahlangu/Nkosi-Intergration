/** Highlights search terms safely: splits text and wraps matches in <mark>; never injects HTML. */
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const ts = terms.filter((t) => t.length >= 2);
  if (!ts.length || !text) return <>{text}</>;
  const re = new RegExp(`(${ts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  const parts = text.split(re);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <mark className="hl" key={i}>
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export const termsOf = (q: string) => [...new Set(q.toLowerCase().split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter((t) => t.length >= 2))].slice(0, 6);
