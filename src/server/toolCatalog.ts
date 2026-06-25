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
  // Adobe Analytics categories
  reportsuite: { id: "reportsuite", label: "Report Suites", order: 12 },
  dimension: { id: "dimension", label: "Dimensions", order: 13 },
  metric: { id: "metric", label: "Metrics", order: 14 },
  segment: { id: "segment", label: "Segments", order: 15 },
  report: { id: "report", label: "Reports & Queries", order: 16 },
  // Adobe Launch / Data Collection (Tags) categories
  launchProperty: { id: "launchProperty", label: "Launch Properties", order: 20 },
  rule: { id: "rule", label: "Rules", order: 21 },
  dataElement: { id: "dataElement", label: "Data Elements", order: 22 },
  extension: { id: "extension", label: "Extensions", order: 23 },
  environment: { id: "environment", label: "Environments", order: 24 },
  library: { id: "library", label: "Libraries & Builds", order: 25 },
  hostAdapter: { id: "hostAdapter", label: "Hosts & Adapters", order: 26 },
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
  // Adobe Launch / Data Collection (Tags) — checked early so e.g. "data_element"
  // and "rule_component" don't get mis-bucketed.
  [/data_?element/i, "dataElement"],
  [/\brule/i, "rule"],
  [/extension/i, "extension"],
  [/environment/i, "environment"],
  [/librar|\bbuild|publish/i, "library"],
  [/\bhost|adapter/i, "hostAdapter"],
  [/launch_?propert|tags?_propert/i, "launchProperty"],
  // Adobe Analytics (checked first so e.g. "report_suite" wins over "report")
  [/report_?suite|rsid|suite/i, "reportsuite"],
  [/dimension/i, "dimension"],
  [/\bmetric|calculated_metric|measure/i, "metric"],
  [/segment/i, "segment"],
  [/freeform|ranked|trended|run_report|query|breakdown|data_warehouse|cja/i, "report"],
  // Adobe Target
  [/activity|activities|experience/i, "activity"],
  [/performance|orders/i, "reporting"],
  [/audience/i, "audience"],
  [/offer/i, "offer"],
  [/recommendation|criteria|catalog/i, "recommendations"],
  [/mbox|profile/i, "mbox"],
  [/propert/i, "property"],
  [/preview|qa/i, "preview"],
  [/revision/i, "revision"],
  [/template/i, "template"],
  [/response_token|implementation|setting|config/i, "implementation"],
  [/report|analytics/i, "report"],
];

export function categorizeTool(toolName: string): ToolCategory {
  const known = KNOWN_TOOL_CATEGORY[toolName];
  if (known) return CATEGORIES[known];

  for (const [pattern, categoryId] of HEURISTICS) {
    if (pattern.test(toolName)) return CATEGORIES[categoryId];
  }
  return CATEGORIES.other;
}

export interface RawTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface CatalogTool extends RawTool {
  category: ToolCategory;
}

export interface ToolCatalogGroup {
  category: ToolCategory;
  tools: CatalogTool[];
}

/** Groups a flat tool list into category buckets sorted for display. */
export function groupToolsByCategory(tools: RawTool[]): ToolCatalogGroup[] {
  const grouped = new Map<string, CatalogTool[]>();
  for (const tool of tools) {
    const category = categorizeTool(tool.name);
    const entry: CatalogTool = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      category,
    };
    const list = grouped.get(category.id) ?? [];
    list.push(entry);
    grouped.set(category.id, list);
  }

  return Array.from(grouped.entries())
    .map(([id, catTools]) => ({
      category: CATEGORIES[id] ?? CATEGORIES.other,
      tools: catTools.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.order - b.category.order);
}
