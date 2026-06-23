/**
 * Maps Adobe Target MCP tool names to human-friendly categories. This is used
 * purely for grouping/presentation in the UI. Tools are always discovered live
 * from the server via `tools/list`; this catalog only enriches the display and
 * gracefully falls back to a heuristic for any tool it does not recognize.
 */

export interface ToolCategory {
  id: string;
  label: string;
  /** Lower number sorts earlier in the UI. */
  order: number;
}

export const CATEGORIES: Record<string, ToolCategory> = {
  activity: { id: "activity", label: "Activities", order: 1 },
  reporting: { id: "reporting", label: "Reporting", order: 2 },
  audience: { id: "audience", label: "Audiences", order: 3 },
  offer: { id: "offer", label: "Offers", order: 4 },
  recommendations: { id: "recommendations", label: "Recommendations", order: 5 },
  mbox: { id: "mbox", label: "Mboxes & Profiles", order: 6 },
  property: { id: "property", label: "Properties", order: 7 },
  preview: { id: "preview", label: "QA & Preview", order: 8 },
  revision: { id: "revision", label: "Revisions", order: 9 },
  template: { id: "template", label: "Templates", order: 10 },
  implementation: { id: "implementation", label: "Implementation", order: 11 },
  other: { id: "other", label: "Other", order: 99 },
};

/** Explicit overrides for known tools where the name heuristic is imperfect. */
const KNOWN_TOOL_CATEGORY: Record<string, string> = {
  list_target_activities: "activity",
  get_ab_activity: "activity",
  get_xt_activity: "activity",
  get_abt_activity: "activity",
  create_ab_activity: "activity",
  get_ab_performance_report: "reporting",
  get_ab_orders_report: "reporting",
  get_xt_performance_report: "reporting",
  get_xt_orders_report: "reporting",
  get_activity_report_by_name: "reporting",
  list_target_audiences: "audience",
  list_target_offers: "offer",
  get_target_offer: "offer",
  list_target_mboxes: "mbox",
  get_target_mbox: "mbox",
  list_target_mbox_profile_attributes: "mbox",
  list_target_properties: "property",
  preview_activity: "preview",
  list_target_response_tokens: "implementation",
  get_target_revisions: "revision",
  get_target_entity_revisions: "revision",
  list_target_templates: "template",
};

const HEURISTICS: Array<[RegExp, string]> = [
  [/activity|activities|experience/i, "activity"],
  [/report|performance|orders|analytics/i, "reporting"],
  [/audience/i, "audience"],
  [/offer/i, "offer"],
  [/recommendation|criteria|catalog/i, "recommendations"],
  [/mbox|profile/i, "mbox"],
  [/propert/i, "property"],
  [/preview|qa/i, "preview"],
  [/revision/i, "revision"],
  [/template/i, "template"],
  [/response_token|implementation|setting|config/i, "implementation"],
];

export function categorizeTool(toolName: string): ToolCategory {
  const known = KNOWN_TOOL_CATEGORY[toolName];
  if (known) return CATEGORIES[known];

  for (const [pattern, categoryId] of HEURISTICS) {
    if (pattern.test(toolName)) return CATEGORIES[categoryId];
  }
  return CATEGORIES.other;
}
