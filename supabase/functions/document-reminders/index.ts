import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DocumentType {
  id: string;
  name: string;
  slug: string;
  reminder_days_before_expiry: number[];
}

interface DocumentToRemind {
  id: string;
  driver_id: string;
  document_type: string;
  document_name: string;
  expiry_date: string;
  reminder_sent_days: number[];
  document_type_id: string;
  driver: {
    first_name: string;
    last_name: string;
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("Starting document reminder check...");

    // Get all document types with expiry tracking enabled
    const { data: documentTypes, error: dtError } = await supabase
      .from("document_types")
      .select("*")
      .eq("has_expiry", true)
      .eq("is_active", true);

    if (dtError) throw dtError;

    const documentTypesMap = new Map<string, DocumentType>();
    documentTypes?.forEach((dt: DocumentType) => {
      documentTypesMap.set(dt.slug, dt);
      documentTypesMap.set(dt.id, dt);
    });

    // Get all approved documents with expiry dates that haven't expired yet
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const { data: documents, error: docsError } = await supabase
      .from("documents")
      .select(`
        id,
        driver_id,
        document_type,
        document_name,
        expiry_date,
        reminder_sent_days,
        document_type_id,
        driver:drivers(first_name, last_name)
      `)
      .eq("status", "approved")
      .not("expiry_date", "is", null)
      .gte("expiry_date", today.toISOString().split("T")[0]);

    if (docsError) throw docsError;

    console.log(`Found ${documents?.length || 0} documents to check for reminders`);

    const remindersCreated: string[] = [];

for (const doc of (documents || []) as unknown as DocumentToRemind[]) {
      // Handle array relation from Supabase
      const driverInfo = Array.isArray(doc.driver) ? doc.driver[0] : doc.driver;
      // Get document type config
      const docType = documentTypesMap.get(doc.document_type) || 
                      documentTypesMap.get(doc.document_type_id);
      
      if (!docType) {
        console.log(`No document type config found for: ${doc.document_type}`);
        continue;
      }

      const reminderDays = docType.reminder_days_before_expiry || [30, 14, 7, 3, 1];
      const alreadySent = doc.reminder_sent_days || [];
      
      // Calculate days until expiry
      const expiryDate = new Date(doc.expiry_date);
      expiryDate.setHours(0, 0, 0, 0);
      const daysUntilExpiry = Math.ceil((expiryDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

      // Check if any reminder day matches and hasn't been sent
      for (const reminderDay of reminderDays) {
        if (daysUntilExpiry === reminderDay && !alreadySent.includes(reminderDay)) {
          console.log(`Sending ${reminderDay}-day reminder for document ${doc.id} to driver ${doc.driver_id}`);

          // Create inbox message
          const title = daysUntilExpiry === 1 
            ? `⚠️ ${doc.document_name} expires TOMORROW!`
            : daysUntilExpiry <= 7
            ? `⚠️ ${doc.document_name} expires in ${daysUntilExpiry} days`
            : `📋 ${doc.document_name} expires in ${daysUntilExpiry} days`;

          const body = daysUntilExpiry <= 3
            ? `URGENT: Your ${doc.document_name} will expire on ${new Date(doc.expiry_date).toLocaleDateString()}. Please upload a renewed document immediately to avoid service interruption.`
            : `Your ${doc.document_name} will expire on ${new Date(doc.expiry_date).toLocaleDateString()}. Please prepare to upload a renewed document before it expires.`;

          const { error: inboxError } = await supabase
            .from("driver_inbox_messages")
            .insert({
              driver_id: doc.driver_id,
              type: "DOCUMENT_REMINDER",
              title,
              body,
              document_type_id: doc.document_type_id || docType.id,
              document_id: doc.id,
              expiry_date: doc.expiry_date,
              metadata: {
                reminder_day: reminderDay,
                days_until_expiry: daysUntilExpiry,
              },
            });

          if (inboxError) {
            console.error(`Failed to create inbox message for doc ${doc.id}:`, inboxError);
            continue;
          }

          // Update document to track that this reminder was sent
          const updatedReminderDays = [...alreadySent, reminderDay];
          const { error: updateError } = await supabase
            .from("documents")
            .update({
              reminder_sent_days: updatedReminderDays,
              last_reminded_at: new Date().toISOString(),
            })
            .eq("id", doc.id);

          if (updateError) {
            console.error(`Failed to update reminder tracking for doc ${doc.id}:`, updateError);
          } else {
            remindersCreated.push(`${doc.document_name} (${reminderDay} days)`);
          }

          // Only send one reminder per document per run
          break;
        }
      }
    }

    console.log(`Created ${remindersCreated.length} reminders`);

    return new Response(
      JSON.stringify({
        success: true,
        remindersCreated: remindersCreated.length,
        details: remindersCreated,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Error in document-reminders:", error);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 500,
      }
    );
  }
});
