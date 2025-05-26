// Imports global types
import "@twilio-labs/serverless-runtime-types";

// Fetches specific types
import {
  Context,
  ServerlessCallback,
  ServerlessEventObject,
  ServerlessFunctionSignature,
} from "@twilio-labs/serverless-runtime-types/types";

// Type(s)
type RequestContext = {
  TWILIO_FLEX_WORKSPACE_SID: string;
  TWILIO_FLEX_WORKFLOW_SID: string;
  TWILIO_AIA_WEBHOOK_NAME: string;
};

type RequestEvent = {
  workspaceSid?: string;
  workflowSid?: string;
  request: any;
};

export const handler: ServerlessFunctionSignature<
  RequestContext,
  ServerlessEventObject<RequestEvent>
> = async function (
  context: Context<RequestContext>,
  event: ServerlessEventObject<RequestEvent>,
  callback: ServerlessCallback
) {
  console.log("[flex-handover] Event Received", event);

  const response = new Twilio.Response();

  // Set the CORS headers to allow Flex to make an error-free HTTP request
  // to this Function
  response.appendHeader("Access-Control-Allow-Origin", "*");
  response.appendHeader("Access-Control-Allow-Methods", "OPTIONS, GET, POST");
  response.appendHeader("Access-Control-Allow-Headers", "Content-Type");
  response.appendHeader("Content-Type", "application/json");

  // Check Required Parameters
  if (
    (!event.workflowSid || event.workflowSid == "") &&
    (!context.TWILIO_FLEX_WORKFLOW_SID ||
      context.TWILIO_FLEX_WORKFLOW_SID == "")
  ) {
    console.log("[flex-handover] Invalid workflowSid");
    response.setStatusCode(400);
    response.setBody({ status: "Invalid workflowSid" });
    return callback(null, response);
  }

  // Core Logic
  const client = context.getTwilioClient();
  const sessionId = event.request.headers["x-session-id"];
  const identityHeader = event.request.headers["x-identity"];

  /*
   * Step 1: Formulate Additional Task Attributes
   * Note: This will pass all parameters that have been declared under AI Assistant Tool's Input Parameter as Task Attributes
   */
  let taskAttributes = event;
  delete taskAttributes["request"];

  /*
   * Step 2: Check Incoming Channel Type
   */
  if (sessionId.startsWith("voice")) {
    // Channel: Voice
    const [callSid] = sessionId.replace("voice:", "").split("/");
    const callUpdateResult = await client.calls(callSid).update({
      twiml: `
        <Response>
            <Enqueue workflowSid="${
              event.workflowSid ?? context.TWILIO_FLEX_WORKFLOW_SID
            }">
                <Task>${JSON.stringify(taskAttributes)}</Task>
            </Enqueue>
        </Response>
      `,
    });
    response.setBody(callUpdateResult);
    return callback(null, response);
  } else {
    // Channel: Conversation-based Channel
    const [serviceSid, conversationsSid] = sessionId
      .replace("webhook:conversations__", "")
      .split("/");
    const [traitName, identity] = identityHeader.split(":");
    console.log(`[flex-handover] Chat Service SID: ${serviceSid}`);
    console.log(`[flex-handover] Conversation SID: ${conversationsSid}`);
    console.log(`[flex-handover] Trait Name: ${traitName}`);
    console.log(`[flex-handover] Identity: ${identity}`);

    // -- Validate Conversation Required Parameters
    if (!identity || !conversationsSid) {
      console.log("[flex-handover] Invalid identity or conversationSid");
      response.setStatusCode(400);
      response.setBody({ status: "Invalid identity or conversationSid" });
      return callback(null, response);
    }
    // -- Check Required Parameters for Conversation-based Channel
    if (
      (!event.workspaceSid || event.workspaceSid == "") &&
      (!context.TWILIO_FLEX_WORKSPACE_SID ||
        context.TWILIO_FLEX_WORKSPACE_SID == "")
    ) {
      console.log("[flex-handover] Invalid workspaceSid");
      response.setStatusCode(400);
      response.setBody({ status: "Invalid workspaceSid" });
      return callback(null, response);
    }

    // -- Remove AIA Adapter Webhook from Conversations
    // -- Note: Prevent AI Assistant from responding after transferring over to Twilio Flex
    if (context.TWILIO_AIA_WEBHOOK_NAME) {
      console.log("[flex-handover] Removing AIA Webhook...");
      console.log(
        `[flex-handover] Looking for friendly name: "${context.TWILIO_AIA_WEBHOOK_NAME}" to remove`
      );
      const webhooks = await client.conversations.v1
        .conversations(conversationsSid)
        .webhooks.list();
      const filteredWebhooks = webhooks.filter(
        (entry) =>
          entry.target === "webhook" &&
          entry.configuration?.url?.includes(context.TWILIO_AIA_WEBHOOK_NAME)
      );
      if (filteredWebhooks.length === 1) {
        const selectedWebhookSid = filteredWebhooks[0].sid;
        try {
          await client.conversations.v1
            .conversations(conversationsSid)
            .webhooks(selectedWebhookSid)
            .remove();
          console.log(
            `[flex-handover] Successfully removed AIA webhook with the SID: ${selectedWebhookSid}`
          );
        } catch (err) {
          console.log(
            `[flex-handover] Catch Error - Unable to removed AIA webhook. Fail gracefully and continue`
          );
          console.log(err);
        }
      } else {
        console.log(
          `[flex-handover] No AIA webhook found.. Skipping removing..`
        );
      }
    }

    try {
      let from = identity;
      let customerName = identity;
      let customerAddress = identity;
      let channelType = "chat";
      if (traitName === "whatsapp") {
        channelType = "whatsapp";
        from = `whatsapp:${identity}`;
        customerName = from;
        customerAddress = from;
      } else if (identity.startsWith("+")) {
        channelType = "sms";
        customerName = from;
        customerAddress = from;
      } else if (identity.startsWith("FX") || traitName === "email") {
        // Flex Webchat
        // Assumption: Email Identity is associated to Flex Webchat
        // -- Optain Participant Flex Context ID
        let flexContextSID = from;
        const conversationParticipant = await client.conversations.v1
          .conversations(conversationsSid)
          .participants.list({ limit: 1 });
        if (
          conversationParticipant.length === 1 &&
          conversationParticipant[0]?.identity?.startsWith("FX")
        ) {
          flexContextSID = conversationParticipant[0].identity;
        }
        channelType = "web";
        customerName = flexContextSID;
        customerAddress = flexContextSID;
        try {
          const user = await client.conversations.v1.users(identity).fetch();
          from = user.friendlyName;
        } catch (err) {
          console.error(err);
        }
      }
      const interactionPayload = {
        channel: {
          type: channelType,
          initiated_by: "customer",
          properties: {
            media_channel_sid: conversationsSid,
          },
        },
        routing: {
          properties: {
            workspace_sid:
              event.workspaceSid ?? context.TWILIO_FLEX_WORKSPACE_SID,
            workflow_sid: event.workflowSid ?? context.TWILIO_FLEX_WORKFLOW_SID,
            task_channel_unique_name: "chat",
            attributes: {
              from,
              customerName,
              customerAddress,
              ...taskAttributes,
            },
          },
        },
      };
      console.log("[flex-handover] Creating interaction payload...");
      console.log(interactionPayload.channel);
      console.log(interactionPayload.routing);
      const result = await client.flexApi.v1.interaction.create(
        interactionPayload
      );
      response.setBody(result);
      console.log(
        `[flex-handover] Successfully handover to Twilio Flex. SID: ${result.sid}`
      );
      return callback(null, response);
    } catch (err) {
      console.log("[flex-handover] Catch Error");
      console.error(err);
      response.setStatusCode(500);
      response.setBody({ status: "Catch Error" });
      return callback(null, response);
    }
  }
};
