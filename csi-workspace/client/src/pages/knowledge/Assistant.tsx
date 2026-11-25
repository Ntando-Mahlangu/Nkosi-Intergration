import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuth, useToast } from "../../lib/app-state";
import { AIBadge, Badge, Button, Callout } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { humanize } from "../../lib/format";

interface AssistantResponse {
  engine: string;
  answer: string | null;
  insufficient: boolean;
  citations: { type: string; id: string; title: string; url: string }[];
  results: { type: string; id: string; title: string; category: string; snippet: string; url: string }[];
  note: string;
}

const EXAMPLES = ["Where can I find the supplier onboarding process?", "What lessons were learned from our previous programmes?", "What decisions have been made about Change OS?"];

export function KnowledgeAssistant() {
  const { me } = useAuth();
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [resp, setResp] = useState<AssistantResponse | null>(null);
  const [feedback, setFeedback] = useState<"helpful" | "not_helpful" | null>(null);

  const ask = async (q = question) => {
    const text = q.trim();
    if (text.length < 3) {
      setErr("Ask a question of at least 3 characters.");
      return;
    }
    setErr("");
    setBusy(true);
    setFeedback(null);
    try {
      const r = await api.post<AssistantResponse>("/assistant/ask", { question: text });
      setResp(r);
      setAsked(text);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendFeedback = async (rating: "helpful" | "not_helpful") => {
    try {
      await api.post("/ai/feedback", { feature: "knowledge_assistant", rating, comment: asked.slice(0, 200) });
      setFeedback(rating);
      toast.success("Thanks — your feedback helps improve the assistant.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const aiOn = !!me?.ai.aiAvailable;
  return (
    <section className="ai-panel kno-assistant" aria-labelledby="kno-assistant-title">
      <div className="card-body stack">
        <div className="row-between">
          <h2 id="kno-assistant-title" className="row">
            <Icon name="sparkles" size={18} /> Ask CSI Knowledge
          </h2>
          <span className="ai-label">{aiOn ? "AI-assisted · cites sources" : "Keyword search (AI not configured)"}</span>
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          <label htmlFor="kno-ask" className="sr-only">
            Your question
          </label>
          <input id="kno-ask" className="input" style={{ flex: 1, minWidth: 200 }} placeholder="e.g. What lessons were learned from previous programmes?" value={question} maxLength={500} onChange={(e) => setQuestion(e.target.value)} aria-invalid={!!err} />
          <Button type="submit" variant="ai" icon="send" loading={busy}>
            Ask
          </Button>
        </form>
        {err && (
          <span className="error small" role="alert" style={{ color: "var(--danger)" }}>
            {err}
          </span>
        )}
        {!resp && (
          <div className="row small muted">
            Try:
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="kno-chip"
                onClick={() => {
                  setQuestion(ex);
                  ask(ex);
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        )}
        {resp && (
          <div className="stack" aria-live="polite">
            <div className="row small">
              <span className="muted">Question:</span> <strong>{asked}</strong>
            </div>
            {resp.answer ? (
              <div className="answer stack-sm">
                <div className="row">
                  <AIBadge engine={resp.engine} />
                  {resp.insufficient && <Badge tone="warn" icon="alertCircle">Insufficient information</Badge>}
                </div>
                <div className="prewrap">{resp.answer}</div>
                {resp.citations.length > 0 && (
                  <div className="small">
                    <strong>Sources: </strong>
                    {resp.citations.map((c, i) => (
                      <span key={c.type + c.id}>
                        {i > 0 && " · "}
                        <Link to={c.url}>{c.title}</Link> <span className="muted tiny">({humanize(c.type)})</span>
                      </span>
                    ))}
                  </div>
                )}
                <div className="row small muted">
                  Was this helpful?
                  <Button size="sm" variant="ghost" icon="thumbsUp" aria-pressed={feedback === "helpful"} onClick={() => sendFeedback("helpful")} disabled={!!feedback}>
                    Yes
                  </Button>
                  <Button size="sm" variant="ghost" icon="thumbsDown" aria-pressed={feedback === "not_helpful"} onClick={() => sendFeedback("not_helpful")} disabled={!!feedback}>
                    No
                  </Button>
                </div>
              </div>
            ) : (
              <Callout tone={resp.insufficient ? "warn" : "ai"} icon="info">
                {resp.note}
              </Callout>
            )}
            {resp.results.length > 0 && (
              <div className="stack-sm">
                <span className="small strong">{resp.answer ? "Records considered" : "Most relevant records"}</span>
                <div className="card list">
                  {resp.results.map((r) => (
                    <div className="list-item" key={r.type + r.id}>
                      <div style={{ minWidth: 0 }}>
                        <Link className="title" to={r.url}>
                          {r.title}
                        </Link>
                        <div className="meta">
                          <span>{r.category}</span>
                        </div>
                        {r.snippet && <div className="small muted">{r.snippet}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <Button size="sm" variant="ghost" icon="x" onClick={() => { setResp(null); setQuestion(""); }}>
                Clear
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
