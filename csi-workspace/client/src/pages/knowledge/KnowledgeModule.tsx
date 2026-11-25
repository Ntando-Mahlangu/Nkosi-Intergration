import { useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { useApi, useDebounced } from "../../lib/hooks";
import { useAuth, useLookups } from "../../lib/app-state";
import { fmtDate, plural } from "../../lib/format";
import { Badge, Button, Card, EmptyState, ErrorState, LinkButton, Loading, PageHeader, StatusBadge, Tags } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { KnowledgeAssistant } from "./Assistant";
import KnowledgeForm from "./KnowledgeForm";
import KnowledgeDetail from "./KnowledgeDetail";
import ProceduresPage from "./ProceduresPage";
import { ACCESS_LABEL, ITEM_TYPE_ICON, ITEM_TYPE_LABEL, ITEM_TYPES, type Discover, type KnowledgeListItem } from "./types";
import { Highlight, termsOf } from "./Highlight";
import "./knowledge.css";

export default function KnowledgeModule() {
  return (
    <Routes>
      <Route index element={<KnowledgeHub />} />
      <Route path="new" element={<KnowledgeForm />} />
      <Route path="procedures" element={<ProceduresPage />} />
      <Route path=":id" element={<KnowledgeDetail />} />
      <Route path=":id/edit" element={<KnowledgeForm />} />
    </Routes>
  );
}

// ------------------------------------------------------------------ list row
export function KnowledgeRow({ item, terms = [], showStatus }: { item: KnowledgeListItem; terms?: string[]; showStatus?: boolean }) {
  return (
    <div className="kno-item">
      <span className={`kno-ico ${item.item_type}`} aria-hidden>
        <Icon name={ITEM_TYPE_ICON[item.item_type] ?? "book"} size={16} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <Link className="title" to={`/knowledge/${item.id}`}>
          <Highlight text={item.title} terms={terms} />
        </Link>
        {item.summary && (
          <div className="summary">
            <Highlight text={item.summary} terms={terms} />
          </div>
        )}
        <div className="kno-meta">
          <span>{ITEM_TYPE_LABEL[item.item_type] ?? item.item_type}</span>
          <span>{item.category}</span>
          {item.project_name && <span>{item.project_name}</span>}
          {item.author_name && <span>By {item.author_name}</span>}
          <span>{fmtDate(item.published_date ?? item.updated_at)}</span>
          {item.access_level !== "all_staff" && (
            <Badge tone="neutral" icon="lock">
              {ACCESS_LABEL[item.access_level]}
            </Badge>
          )}
          {(showStatus || item.status !== "published") && <StatusBadge kind="knowledge" value={item.status} />}
          <Tags value={item.tags} />
        </div>
      </div>
    </div>
  );
}

function Section({ title, items, empty, action, showStatus }: { title: string; items: KnowledgeListItem[]; empty: string; action?: React.ReactNode; showStatus?: boolean }) {
  return (
    <Card title={title} actions={action} pad={false}>
      {items.length ? (
        <div className="list">
          {items.map((i) => (
            <KnowledgeRow key={i.id} item={i} showStatus={showStatus} />
          ))}
        </div>
      ) : (
        <p className="muted small" style={{ padding: "14px 20px", margin: 0 }}>
          {empty}
        </p>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ hub
const SORTS = [
  { value: "relevance", label: "Most relevant" },
  { value: "recent", label: "Most recent" },
  { value: "popular", label: "Most viewed" },
  { value: "title", label: "Title A–Z" },
];

function KnowledgeHub() {
  const { can } = useAuth();
  const { lookups } = useLookups();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get("q") ?? "");
  const debounced = useDebounced(text, 300);
  const filters = {
    q: params.get("q") ?? "",
    category: params.get("category") ?? "",
    item_type: params.get("item_type") ?? "",
    project_id: params.get("project_id") ?? "",
    author_id: params.get("author_id") ?? "",
    status: params.get("status") ?? "",
    tag: params.get("tag") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    sort: params.get("sort") ?? "",
  };
  const setFilter = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n, { replace: true });
  };
  useEffect(() => {
    if (debounced !== filters.q) setFilter("q", debounced.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  const browsing = Object.entries(filters).some(([k, v]) => v && k !== "sort");
  const discover = useApi<Discover>("/knowledge/discover");
  const list = useApi<{ items: KnowledgeListItem[]; total: number }>(browsing ? "/knowledge" : null, { ...filters, limit: 60 });
  const terms = useMemo(() => termsOf(filters.q), [filters.q]);
  const d = discover.data;
  const categories = useMemo(() => {
    const counts = new Map((d?.categories ?? []).map((c) => [c.category, c.n]));
    const all = new Set([...(lookups?.taxonomies.knowledge_category ?? []), ...counts.keys()]);
    return [...all].map((c) => ({ c, n: counts.get(c) ?? 0 })).filter((x) => x.n > 0 || filters.category === x.c);
  }, [d, lookups, filters.category]);

  return (
    <>
      <PageHeader
        title="Knowledge Hub"
        subtitle="Research, procedures, lessons and institutional memory — searchable and permission-aware."
        actions={
          <>
            <LinkButton to="/knowledge/procedures" icon="tasks">
              Procedures
            </LinkButton>
            {can("knowledge.contribute") && (
              <LinkButton to="/knowledge/new" variant="primary" icon="plus">
                Add knowledge
              </LinkButton>
            )}
          </>
        }
      />

      <div className="kno-hero" role="search">
        <label htmlFor="kno-search" className="sr-only">
          Search knowledge
        </label>
        <input id="kno-search" className="input" type="search" placeholder="Search titles, summaries, content, keywords, tags or authors…" value={text} onChange={(e) => setText(e.target.value)} />
        <select className="select" style={{ width: "auto" }} aria-label="Type" value={filters.item_type} onChange={(e) => setFilter("item_type", e.target.value)}>
          <option value="">All types</option>
          {ITEM_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </div>
      <div className="kno-chips" aria-label="Categories">
        <button className={`kno-chip ${!filters.category ? "active" : ""}`} aria-pressed={!filters.category} onClick={() => setFilter("category", "")}>
          All categories
        </button>
        {categories.map(({ c, n }) => (
          <button key={c} className={`kno-chip ${filters.category === c ? "active" : ""}`} aria-pressed={filters.category === c} onClick={() => setFilter("category", filters.category === c ? "" : c)}>
            {c} <span className="n">{n}</span>
          </button>
        ))}
      </div>

      {browsing ? (
        <BrowseResults filters={filters} setFilter={setFilter} list={list} terms={terms} clear={() => { setText(""); setParams(new URLSearchParams(), { replace: true }); }} />
      ) : discover.loading && !d ? (
        <Loading />
      ) : discover.error ? (
        <ErrorState error={discover.error} onRetry={discover.reload} />
      ) : d ? (
        <div className="cols-main-side">
          <div className="stack" style={{ gap: 18 }}>
            <KnowledgeAssistant />
            {d.awaiting_review.length > 0 && <Section title={`Awaiting your review (${d.awaiting_review.length})`} items={d.awaiting_review} empty="" showStatus />}
            <Section title="Recently added" items={d.recent} empty="Nothing has been published yet." action={<Button size="sm" variant="ghost" onClick={() => setFilter("sort", "recent")}>Browse all</Button>} />
            <Section title="For your projects" items={d.my_projects} empty="No knowledge is linked to your projects yet." />
            <Section title="Lessons & insights" items={d.lessons} empty="No lessons have been captured yet." action={<Button size="sm" variant="ghost" onClick={() => setFilter("item_type", "lesson")}>All lessons</Button>} />
          </div>
          <div className="stack" style={{ gap: 18 }}>
            {d.my_drafts.length > 0 && <Section title="Your drafts & submissions" items={d.my_drafts} empty="" showStatus />}
            {d.review_due.length > 0 && (
              <Card title="Review due" pad={false}>
                <div className="list">
                  {d.review_due.map((i) => (
                    <div className="list-item" key={i.id}>
                      <Icon name="clock" size={16} />
                      <div style={{ minWidth: 0 }}>
                        <Link className="title" to={`/knowledge/${i.id}`}>
                          {i.title}
                        </Link>
                        <div className="meta">
                          <span className={i.review_date && i.review_date < d.today ? "overdue" : "due-today"}>Review {i.review_date && i.review_date < d.today ? "overdue since" : "due"} {fmtDate(i.review_date)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            <Card title="Procedures" actions={<Link to="/knowledge/procedures" className="small">View all</Link>} pad={false}>
              {d.procedures.length ? (
                <div className="list">
                  {d.procedures.map((p) => (
                    <div className="list-item" key={p.id}>
                      <Icon name="tasks" size={16} />
                      <Link className="title" to={`/knowledge/${p.id}`}>
                        {p.title}
                      </Link>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted small" style={{ padding: "14px 20px", margin: 0 }}>No procedures published yet.</p>
              )}
            </Card>
            <Section title="Most viewed" items={d.popular} empty="View counts will appear as people use the Hub." />
          </div>
        </div>
      ) : null}
      {!browsing && d && d.recent.length === 0 && d.my_drafts.length === 0 && (
        <EmptyState icon="book" title="Start building CSI's knowledge base" action={can("knowledge.contribute") ? <Button variant="primary" icon="plus" onClick={() => nav("/knowledge/new")}>Add the first item</Button> : undefined}>
          Capture research, procedures and lessons so they don't depend on one person remembering.
        </EmptyState>
      )}
    </>
  );
}

function BrowseResults({
  filters,
  setFilter,
  list,
  terms,
  clear,
}: {
  filters: Record<string, string>;
  setFilter: (k: string, v: string) => void;
  list: ReturnType<typeof useApi<{ items: KnowledgeListItem[]; total: number }>>;
  terms: string[];
  clear: () => void;
}) {
  const { lookups } = useLookups();
  const { can } = useAuth();
  return (
    <div className="stack">
      <div className="filter-bar">
        <select className="select" aria-label="Project" value={filters.project_id} onChange={(e) => setFilter("project_id", e.target.value)}>
          <option value="">All projects</option>
          {(lookups?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Author" value={filters.author_id} onChange={(e) => setFilter("author_id", e.target.value)}>
          <option value="">Any author</option>
          {(lookups?.users ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Status" value={filters.status} onChange={(e) => setFilter("status", e.target.value)}>
          <option value="">Current (not archived)</option>
          <option value="published">Published</option>
          <option value="draft">My drafts</option>
          {can("knowledge.manage") && <option value="in_review">In review</option>}
          <option value="archived">Archived</option>
        </select>
        <label className="small muted row" style={{ gap: 4 }}>
          From
          <input className="input" type="date" style={{ minWidth: 0 }} value={filters.from} onChange={(e) => setFilter("from", e.target.value)} />
        </label>
        <label className="small muted row" style={{ gap: 4 }}>
          To
          <input className="input" type="date" style={{ minWidth: 0 }} value={filters.to} onChange={(e) => setFilter("to", e.target.value)} />
        </label>
        <select className="select" aria-label="Sort" value={filters.sort || (filters.q ? "relevance" : "recent")} onChange={(e) => setFilter("sort", e.target.value)}>
          {SORTS.filter((s) => s.value !== "relevance" || filters.q).map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <Button variant="ghost" icon="x" onClick={clear}>
          Clear filters
        </Button>
      </div>
      {filters.tag && (
        <div className="row small">
          Tag: <span className="tag">{filters.tag}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setFilter("tag", "")} aria-label="Remove tag filter">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}
      {list.loading && !list.data ? (
        <Loading />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={list.reload} />
      ) : list.data && list.data.items.length ? (
        <>
          <div className="muted small" aria-live="polite">
            {plural(list.data.total, "item")} found
          </div>
          <div className="card">
            {list.data.items.map((i) => (
              <KnowledgeRow key={i.id} item={i} terms={terms} />
            ))}
          </div>
        </>
      ) : (
        <EmptyState icon="search" title="No knowledge items match" action={<Button onClick={clear}>Clear filters</Button>}>
          Try fewer words, another category, or ask the assistant. Restricted items only appear for people with access.
        </EmptyState>
      )}
    </div>
  );
}
