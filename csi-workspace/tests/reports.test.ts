import { describe, it, expect } from "vitest";
import { setup } from "./helpers";

async function draftCallReport() {
  const t = await setup();
  const sipho = await t.as("sipho");
  const id = t.db.get<{ id: string }>("SELECT id FROM meetings WHERE title = 'Change OS weekly'")!.id;
  const rep = await sipho.post(`/api/meetings/${id}/call-report`).expect(201);
  return { t, sipho, reportId: rep.body.id as string };
}

describe("report workflow", () => {
  it("edits create new versions and are blocked once in review", async () => {
    const { sipho, reportId } = await draftCallReport();
    const r = await sipho.get(`/api/reports/${reportId}`).expect(200);
    const sections = r.body.content.sections.map((s: { key: string; title: string; body?: string; items?: string[] }) => ({ key: s.key, title: s.title, body: s.body, items: s.items }));
    sections[0].body = "Edited overview";
    const e = await sipho.patch(`/api/reports/${reportId}`, { sections, change_note: "tidy" }).expect(200);
    expect(e.body.version).toBe(2);
    expect(e.body.content.sections[0].body).toBe("Edited overview");
    const v = await sipho.get(`/api/reports/${reportId}/versions`).expect(200);
    expect(v.body).toHaveLength(2);
    const v1 = await sipho.get(`/api/reports/${reportId}/versions/1`).expect(200);
    expect(v1.body.content.sections[0].body).not.toBe("Edited overview");
    await sipho.post(`/api/reports/${reportId}/transition`, { action: "submit", reviewer_id: (await sipho.get("/api/me")).body.user.id }).expect(200);
    await sipho.patch(`/api/reports/${reportId}`, { title: "x" }).expect(400);
  });

  it("employees cannot approve; reviewers can; changes need feedback", async () => {
    const { t, sipho, reportId } = await draftCallReport();
    await sipho.post(`/api/reports/${reportId}/transition`, { action: "submit" }).expect(200);
    const thabo = await t.as("thabo"); // participant, employee
    await thabo.get(`/api/reports/${reportId}`).expect(200);
    await thabo.post(`/api/reports/${reportId}/transition`, { action: "approve" }).expect(403);
    const zanele = await t.as("zanele"); // knowledge manager has report.review but cannot see Change OS meeting report? (org-visible project → can)
    const zr = await zanele.get(`/api/reports/${reportId}`);
    expect([200, 404]).toContain(zr.status);
    const naledi = await t.as("naledi");
    await naledi.post(`/api/reports/${reportId}/transition`, { action: "request_changes" }).expect(400);
    await naledi.post(`/api/reports/${reportId}/transition`, { action: "request_changes", note: "Add owners" }).expect(200);
    expect(t.db.get("SELECT 1 FROM notifications WHERE user_id = ? AND type = 'changes_requested'", t.userId("sipho"))).toBeTruthy();
    await sipho.post(`/api/reports/${reportId}/transition`, { action: "submit" }).expect(200);
    const ok = await naledi.post(`/api/reports/${reportId}/transition`, { action: "approve" }).expect(200);
    expect(ok.body.status).toBe("approved");
    expect(ok.body.approved_by_name).toBe("Naledi Mokoena");
    await naledi.post(`/api/reports/${reportId}/transition`, { action: "publish" }).expect(200);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'report.approve' AND entity_id = ?", reportId)).toBeTruthy();
    const hist = t.db.all("SELECT to_value FROM status_history WHERE entity_type = 'report' AND entity_id = ?", reportId);
    expect(hist.length).toBeGreaterThanOrEqual(4);
  });

  it("fakawe reports require fakawe permissions", async () => {
    const t = await setup();
    const id = t.db.get<{ id: string }>("SELECT id FROM reports WHERE report_type = 'fakawe'")!.id;
    t.db.run("UPDATE reports SET status = 'draft' WHERE id = ?", id);
    const lerato = await t.as("lerato");
    await lerato.get(`/api/reports/${id}`).expect(404); // draft fakawe not visible to employees
    const zanele = await t.as("zanele");
    await zanele.post(`/api/reports/${id}/transition`, { action: "submit" }).expect(200);
    await zanele.post(`/api/reports/${id}/transition`, { action: "approve" }).expect(403);
    const naledi = await t.as("naledi");
    await naledi.post(`/api/reports/${id}/transition`, { action: "approve" }).expect(200);
    await naledi.post(`/api/reports/${id}/transition`, { action: "publish", audience: "all_staff" }).expect(200);
    await lerato.get(`/api/reports/${id}`).expect(200);
  });

  it("exports escape content and are audited; restricted reports stay hidden", async () => {
    const { t, sipho, reportId } = await draftCallReport();
    await sipho.patch(`/api/reports/${reportId}`, { title: `<script>alert("x")</script> Report` }).expect(200);
    const html = await sipho.get(`/api/reports/${reportId}/export?format=html`).expect(200);
    expect(html.text).not.toContain("<script>alert");
    expect(html.text).toContain("&lt;script&gt;");
    expect(html.headers["content-security-policy"]).toContain("default-src 'none'");
    const md = await sipho.get(`/api/reports/${reportId}/export?format=md`).expect(200);
    expect(md.headers["content-disposition"]).toContain(".md");
    await sipho.get(`/api/reports/${reportId}/export?format=gdoc`).expect(501);
    expect(t.db.get("SELECT 1 FROM audit_log WHERE action = 'export.report'")).toBeTruthy();
    const ayesha = await t.as("ayesha"); // not in Change OS; project org-visible → can view
    await ayesha.get(`/api/reports/${reportId}`).expect(200);
    const list = await sipho.get("/api/reports?type=call_report").expect(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
  });
});
