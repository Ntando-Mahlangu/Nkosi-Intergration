/**
 * Permission catalogue + default role definitions.
 *
 * Roles are stored in the `roles` table and are editable by administrators;
 * the definitions below are only the defaults written on first start.
 * Every check in the API goes through `can(user, perm)` or the record-level
 * access helpers in access.ts — the UI hiding a button is never the control.
 */
export const PERMISSIONS = {
  "project.create": "Create projects",
  "project.manage_any": "Manage any project they can see (not only their own)",
  "project.view_all": "View team-visibility projects without being a member",
  "programme.manage": "Create and edit programmes",
  "task.assign_any": "Assign tasks to anyone (not only within their projects)",
  "meeting.create": "Create meeting records",
  "report.review": "Review and approve call reports for meetings they can see",
  "fakawe.manage": "Manage Fakawe reporting periods and drafts",
  "fakawe.approve": "Approve and publish Fakawe reports",
  "knowledge.contribute": "Submit knowledge items",
  "knowledge.manage": "Review, publish and curate knowledge items",
  "opportunity.view_all": "View the full opportunity pipeline",
  "opportunity.manage": "Create and manage opportunities",
  "management.view": "View management intelligence dashboards",
  "decision.approve": "Approve decisions escalated to management",
  "learning.manage": "Set monthly learning themes and manage the improvement register",
  "ai.use": "Use AI-assisted features",
  "admin.users": "Manage users and teams",
  "admin.roles": "Configure roles and permissions",
  "admin.settings": "Manage application settings, taxonomies, templates, integrations and automations",
  "admin.audit": "View the audit log",
  "admin.data": "Import and export data in bulk; manage retention",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

const EMPLOYEE: Permission[] = ["meeting.create", "knowledge.contribute", "ai.use"];
const PM: Permission[] = [...EMPLOYEE, "project.create", "report.review", "opportunity.manage", "opportunity.view_all"];
const MANAGEMENT: Permission[] = [
  ...PM,
  "project.view_all",
  "programme.manage",
  "task.assign_any",
  "fakawe.approve",
  "management.view",
  "decision.approve",
  "learning.manage",
];
const KNOWLEDGE: Permission[] = [...EMPLOYEE, "knowledge.manage", "fakawe.manage", "report.review", "learning.manage"];
// Administrators configure the system. They do NOT automatically see restricted
// project content, private tasks or confidential meetings (privacy by design).
const ADMIN: Permission[] = [
  ...EMPLOYEE,
  "admin.users",
  "admin.roles",
  "admin.settings",
  "admin.audit",
  "admin.data",
  "knowledge.manage",
];

export const DEFAULT_ROLES: { key: string; name: string; description: string; permissions: Permission[]; sort: number }[] = [
  { key: "employee", name: "Employee", description: "Personal workspace, own tasks, permitted projects and knowledge.", permissions: EMPLOYEE, sort: 1 },
  { key: "project_manager", name: "Project Owner / Manager", description: "Creates and runs projects, assigns work, reviews meeting actions and call reports.", permissions: PM, sort: 2 },
  { key: "management", name: "Management", description: "Organisation-wide portfolio view, decisions, approvals and reporting.", permissions: MANAGEMENT, sort: 3 },
  { key: "knowledge_manager", name: "Knowledge Manager / Reporting Coordinator", description: "Curates the Knowledge Hub and coordinates Fakawe reporting cycles.", permissions: KNOWLEDGE, sort: 4 },
  { key: "admin", name: "System Administrator", description: "Users, roles, settings, integrations, audit and data governance.", permissions: ADMIN, sort: 5 },
];
