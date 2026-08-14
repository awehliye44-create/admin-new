import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface NotificationRequest {
  driver_id: string;
  document_name: string;
  status: "approved" | "rejected";
  rejection_reason?: string;
}

const handler = async (req: Request): Promise<Response> => {
  console.log("send-document-notification: Received request");
  
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    const { driver_id, document_name, status, rejection_reason }: NotificationRequest = await req.json();
    
    console.log(`Processing notification for driver: ${driver_id}, document: ${document_name}, status: ${status}`);

    // Fetch driver details
    const { data: driver, error: driverError } = await supabaseClient
      .from("drivers")
      .select("first_name, last_name, email")
      .eq("id", driver_id)
      .single();

    if (driverError || !driver) {
      console.error("Error fetching driver:", driverError);
      throw new Error("Driver not found");
    }

    console.log(`Sending email to: ${driver.email}`);

    const isApproved = status === "approved";
    const subject = isApproved 
      ? `✅ Document Approved: ${document_name}`
      : `⚠️ Document Rejected: ${document_name}`;

    const htmlContent = isApproved
      ? `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5; margin: 0; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <div style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); padding: 30px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Document Approved! ✅</h1>
            </div>
            <div style="padding: 30px;">
              <p style="color: #374151; font-size: 16px; line-height: 1.6;">
                Hi ${driver.first_name},
              </p>
              <p style="color: #374151; font-size: 16px; line-height: 1.6;">
                Great news! Your document <strong>"${document_name}"</strong> has been reviewed and approved by our team.
              </p>
              <div style="background-color: #d1fae5; border-left: 4px solid #10b981; padding: 15px; margin: 20px 0; border-radius: 4px;">
                <p style="color: #065f46; margin: 0; font-weight: 500;">
                  You're one step closer to completing your driver profile!
                </p>
              </div>
              <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
                Once all your documents are approved, you'll be able to start accepting ride requests.
              </p>
            </div>
            <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                © ${new Date().getFullYear()} ONECAB. All rights reserved.
              </p>
            </div>
          </div>
        </body>
        </html>
      `
      : `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
        </head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f5f5f5; margin: 0; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
            <div style="background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); padding: 30px; text-align: center;">
              <h1 style="color: #ffffff; margin: 0; font-size: 24px;">Document Needs Attention ⚠️</h1>
            </div>
            <div style="padding: 30px;">
              <p style="color: #374151; font-size: 16px; line-height: 1.6;">
                Hi ${driver.first_name},
              </p>
              <p style="color: #374151; font-size: 16px; line-height: 1.6;">
                Unfortunately, your document <strong>"${document_name}"</strong> could not be approved at this time.
              </p>
              <div style="background-color: #fee2e2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0; border-radius: 4px;">
                <p style="color: #991b1b; margin: 0 0 5px 0; font-weight: 600;">Reason for rejection:</p>
                <p style="color: #991b1b; margin: 0;">${rejection_reason || "Please contact support for more details."}</p>
              </div>
              <p style="color: #6b7280; font-size: 14px; line-height: 1.6;">
                Please review the feedback above and upload a new document that meets the requirements. If you have questions, feel free to contact our support team.
              </p>
              <div style="text-align: center; margin-top: 25px;">
                <a href="#" style="display: inline-block; background-color: #3b82f6; color: #ffffff; padding: 12px 30px; border-radius: 8px; text-decoration: none; font-weight: 500;">
                  Re-upload Document
                </a>
              </div>
            </div>
            <div style="background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="color: #9ca3af; font-size: 12px; margin: 0;">
                © ${new Date().getFullYear()} ONECAB. All rights reserved.
              </p>
            </div>
          </div>
        </body>
        </html>
      `;

    const emailResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "ONECAB <onboarding@resend.dev>",
        to: [driver.email],
        subject: subject,
        html: htmlContent,
      }),
    });

    const emailData = await emailResponse.json();

    if (!emailResponse.ok) {
      console.error("Email sending failed:", emailData);
      throw new Error(emailData.message || "Failed to send email");
    }

    console.log("Email sent successfully:", emailData);

    return new Response(
      JSON.stringify({ success: true, data: emailData }),
      {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  } catch (error: any) {
    console.error("Error in send-document-notification:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
};

serve(handler);
