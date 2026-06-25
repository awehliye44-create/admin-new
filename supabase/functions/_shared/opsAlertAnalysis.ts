export type OpsAlertAnalysis = {
  summary: string;
  root_cause: string;
  recommended_action: string;
};

type OpsAlertRow = {
  title: string;
  description: string | null;
  category: string;
  severity: string;
  fingerprint: string;
  fingerprint_count: number | null;
  source: string;
  app: string | null;
  metadata: Record<string, unknown> | null;
  related_trip_id?: string | null;
  related_driver_id?: string | null;
  related_payment_id?: string | null;
};

type OpsLogRow = { level: string; source: string; message: string };

function metadataString(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata || Object.keys(metadata).length === 0) return "none";
  return Object.entries(metadata)
    .map(([key, value]) => `${key}=${value === null ? "null" : String(value)}`)
    .join(", ");
}

export function buildOpsAlertFallbackAnalysis(
  alert: OpsAlertRow,
  logs: OpsLogRow[] | null | undefined,
): OpsAlertAnalysis {
  const meta = alert.metadata ?? {};
  const trigger = typeof meta.trigger === "string" ? meta.trigger : null;
  const eventType = typeof meta.event_type === "string" ? meta.event_type : null;
  const platform = typeof meta.platform === "string" ? meta.platform : null;
  const errorCode = meta.error_code != null ? String(meta.error_code) : null;
  const count = alert.fingerprint_count ?? 1;
  const logHint = logs && logs.length > 0
    ? ` Related logs: ${logs.slice(0, 3).map((l) => `[${l.level}] ${l.message}`).join(" · ")}.`
    : "";

  const isInfoWorkflow = alert.severity === "info" && alert.source === "workflow";
  const isSelfSignout = eventType === "driver_self_signout" || trigger === "manual_sign_out";

  if (isSelfSignout) {
    return {
      summary:
        `Driver manually signed out from the ${alert.app || "driver"} app`
        + (platform ? ` on ${platform}` : "")
        + `. This is a recorded workflow event, not a crash.`,
      root_cause: "Expected user action (manual sign out). No backend failure indicated.",
      recommended_action: count > 3
        ? "Review whether repeated sign-outs are unexpected for this driver; otherwise no action required."
        : "No action required unless the driver reports being signed out unintentionally.",
    };
  }

  if (isInfoWorkflow) {
    return {
      summary:
        `${alert.title}: ${alert.description || "Workflow telemetry event recorded."}`
        + ` Seen ${count} time(s). Metadata: ${metadataString(meta)}.`,
      root_cause: trigger || eventType
        ? `Workflow event (${trigger || eventType}) — informational unless volume spikes.`
        : "Informational workflow telemetry; review metadata for context.",
      recommended_action: count >= 5
        ? "Monitor for recurrence; escalate if the same fingerprint clusters in a short window."
        : "Monitor only; no immediate remediation unless ops confirms user impact.",
    };
  }

  return {
    summary:
      `${alert.title} (${alert.severity} / ${alert.category}) from ${alert.source}`
      + (alert.app ? ` · ${alert.app}` : "")
      + `. ${alert.description || "No description provided."}`
      + ` Occurrences: ${count}.`,
    root_cause: errorCode && errorCode !== "null"
      ? `Reported error_code=${errorCode}. Metadata: ${metadataString(meta)}.${logHint}`
      : `Inspect metadata and related trip/driver IDs. Metadata: ${metadataString(meta)}.${logHint}`,
    recommended_action: alert.related_trip_id
      ? `Open trip ${alert.related_trip_id}, check payment/dispatch logs, and correlate with driver/customer apps.`
      : alert.related_driver_id
      ? `Review driver ${alert.related_driver_id} activity around the alert window and check edge-function logs.`
      : "Review alert metadata, related logs, and replay the user flow on the affected app version.",
  };
}

async function callLovableGateway(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  const body = JSON.stringify(payload);
  const attempts: Record<string, string>[] = [
    { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    { "Lovable-API-Key": apiKey, "Content-Type": "application/json" },
  ];
  if (apiKey.startsWith("lov_")) {
    attempts.unshift({ "Lovable-API-Key": apiKey, "Content-Type": "application/json" });
  }

  let lastResponse: Response | null = null;
  for (const headers of attempts) {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers,
      body,
    });
    lastResponse = res;
    if (res.status !== 401) return res;
    await res.text();
  }
  return lastResponse!;
}

export async function requestOpsAlertAiAnalysis(args: {
  apiKey: string | undefined;
  alert: OpsAlertRow;
  logs: OpsLogRow[] | null | undefined;
}): Promise<{ analysis: OpsAlertAnalysis; modelUsed: string; degraded: boolean }> {
  const fallback = buildOpsAlertFallbackAnalysis(args.alert, args.logs);
  if (!args.apiKey?.trim()) {
    return { analysis: fallback, modelUsed: "deterministic-fallback", degraded: true };
  }

  const userPrompt = `Analyze this ops alert:

Category: ${args.alert.category}
Severity: ${args.alert.severity}
Title: ${args.alert.title}
Description: ${args.alert.description || "N/A"}
Fingerprint: ${args.alert.fingerprint}
Occurrence count: ${args.alert.fingerprint_count}
Source: ${args.alert.source}
App: ${args.alert.app || "N/A"}
Metadata: ${JSON.stringify(args.alert.metadata || {})}
${args.alert.related_trip_id ? `Related Trip: ${args.alert.related_trip_id}` : ""}
${args.alert.related_driver_id ? `Related Driver: ${args.alert.related_driver_id}` : ""}
${args.alert.related_payment_id ? `Related Payment: ${args.alert.related_payment_id}` : ""}

Related error logs (last 10):
${args.logs && args.logs.length > 0
    ? args.logs.map((l) => `[${l.level}] ${l.source}: ${l.message}`).join("\n")
    : "No related logs found."}`;

  const aiPayload = {
    model: "google/gemini-2.5-flash",
    messages: [
      {
        role: "system",
        content:
          "You are an Ops Intelligence AI for ONECAB. Return JSON with summary, root_cause, recommended_action.",
      },
      { role: "user", content: userPrompt },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "ops_alert_analysis",
          description: "Structured ops alert analysis",
          parameters: {
            type: "object",
            properties: {
              summary: { type: "string" },
              root_cause: { type: "string" },
              recommended_action: { type: "string" },
            },
            required: ["summary", "root_cause", "recommended_action"],
            additionalProperties: false,
          },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "ops_alert_analysis" } },
  };

  let aiResponse: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    aiResponse = await callLovableGateway(args.apiKey, aiPayload);
    if (aiResponse.status < 500) break;
    console.warn(`ops-ai-summary gateway attempt ${attempt + 1} failed: ${aiResponse.status}`);
    await aiResponse.text();
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }

  if (!aiResponse?.ok) {
    const errText = await aiResponse?.text().catch(() => "");
    console.error("ops-ai-summary AI gateway unavailable:", aiResponse?.status, errText);
    return { analysis: fallback, modelUsed: "deterministic-fallback", degraded: true };
  }

  const aiResult = await aiResponse.json();
  const toolCall = aiResult.choices?.[0]?.message?.tool_calls?.[0];
  if (toolCall?.function?.arguments) {
    try {
      const parsed = JSON.parse(toolCall.function.arguments) as OpsAlertAnalysis;
      return { analysis: parsed, modelUsed: "google/gemini-2.5-flash", degraded: false };
    } catch {
      // fall through to content parse
    }
  }

  const content = aiResult.choices?.[0]?.message?.content || "";
  try {
    const parsed = JSON.parse(content) as OpsAlertAnalysis;
    return { analysis: parsed, modelUsed: "google/gemini-2.5-flash", degraded: false };
  } catch {
    return {
      analysis: {
        summary: content || fallback.summary,
        root_cause: fallback.root_cause,
        recommended_action: fallback.recommended_action,
      },
      modelUsed: "google/gemini-2.5-flash",
      degraded: false,
    };
  }
}
