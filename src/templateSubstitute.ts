/** Replaces `{key}` placeholders with the given values; unknown placeholders become empty string. */
export function substituteTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? "");
}
