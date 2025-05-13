// Imports global types
import "@twilio-labs/serverless-runtime-types";
import * as AIAUtil from "../common/aia.helper.private";

// Fetches specific types
import {
  Context,
  ServerlessCallback,
  ServerlessEventObject,
  ServerlessFunctionSignature,
} from "@twilio-labs/serverless-runtime-types/types";

// Type(s)
type RequestContext = {
  AUTH_TOKEN: string;
  ACCOUNT_SID: string;
  TWILIO_AIA_IDENTITY: string;
  TWILIO_AIA_IS_TYPING: string;
  TWILIO_FLEX_WORKFLOW_SID: string;
  TWILIO_FLEX_WORKSPACE_SID: string;
};

type RequestEvent = {
  aiAssistantSid: string;
  aiAssistantIsTyping?: boolean;
  aiAssistantIdentity?: string;
  Body: string;
  ConversationSid: string;
  ChatServiceSid: string;
  Author: string;
};

// Load Libraries
const { sendMessageToAIA, verifyRequest, signRequest } = <typeof AIAUtil>(
  require(Runtime.getFunctions()["common/aia.helper"].path)
);

export const handler: ServerlessFunctionSignature<
  RequestContext,
  ServerlessEventObject<RequestEvent>
> = async function (
  context: Context<RequestContext>,
  event: ServerlessEventObject<RequestEvent>,
  callback: ServerlessCallback
) {
  console.log("[conversations][messageAdded] Event Received", event);

  const response = new Twilio.Response();

  // Set the CORS headers to allow Flex to make an error-free HTTP request
  // to this Function
  response.appendHeader("Access-Control-Allow-Origin", "*");
  response.appendHeader("Access-Control-Allow-Methods", "OPTIONS, GET, POST");
  response.appendHeader("Access-Control-Allow-Headers", "Content-Type");
  response.appendHeader("Content-Type", "application/json");

  // Check Required Parameter(s)
  // -- Auth Token: Required for signing JWT Payload
  if (!context.AUTH_TOKEN) {
    console.log(
      "[conversations][messageAdded] Invalid Auth Token",
      context.AUTH_TOKEN
    );
    response.setStatusCode(400);
    response.setBody({ error: "Invalid Auth Token" });
    return callback(null, response);
  }
  // -- AI Assistant SID: Required for sending message to a specific AI Assistant
  if (!event.aiAssistantSid?.startsWith("aia_asst_")) {
    console.log(
      "[conversations][messageAdded] Invalid AI Assistant SID",
      event.aiAssistantSid
    );
    response.setStatusCode(400);
    response.setBody({ error: "Invalid AI Assistant SID" });
    return callback(null, response);
  }
  // -- Conversation SID: Required for formulating AI Assistant's Session ID
  if (!event.ConversationSid?.startsWith("CH")) {
    console.log(
      "[conversations][messageAdded] Invalid Conversation SID",
      event.ConversationSid
    );
    response.setStatusCode(400);
    response.setBody({ error: "Invalid Conversation SID" });
    return callback(null, response);
  }
  // -- Chat Service SID: Required for formulating AI Assistant's Session ID
  if (!event.ChatServiceSid?.startsWith("IS")) {
    console.log(
      "[conversations][messageAdded] Invalid Chat Service SID",
      event.ConversationSid
    );
    response.setStatusCode(400);
    response.setBody({ error: "Invalid Chat Service SID" });
    return callback(null, response);
  }

  // Core Logic
  try {
    const client = context.getTwilioClient();

    /*
     * Step 1: Formulate Identities for End User and AI Assistant
     */
    let identity = event.Author.includes(":")
      ? event.Author
      : `user:${event.Author}`;

    // For WebChat 3.x - Using Email for AIA Identity
    if (identity.startsWith("user:FX")) {
      console.log(
        "[conversations][messageAdded] Identity starts with user:FX indiciating its a Webchat 3.X",
        identity
      );
      const conversationAttributes = await client.conversations.v1
        .services(event.ChatServiceSid)
        .conversations(event.ConversationSid)
        .fetch();

      const parsedConversationAttributes = JSON.parse(
        conversationAttributes.attributes
      );

      if (parsedConversationAttributes.pre_engagement_data?.email) {
        identity = `email:${parsedConversationAttributes.pre_engagement_data.email}`;
      }
    }

    const aiAssistantIdentity = event.aiAssistantIdentity
      ? event.aiAssistantIdentity
      : context.TWILIO_AIA_IDENTITY;

    /*
     * Step 2: Sign JWT Payload for AI Assistant's Response
     */
    const jwtPayload = {
      serviceSid: event.ChatServiceSid,
      conversationSid: event.ConversationSid,
      author: aiAssistantIdentity,
    };
    const signedJwt = signRequest(context.AUTH_TOKEN, jwtPayload);

    /*
     * [Optional] Step 3: Inject "AI Assistant is typing" into Conversation Attribute
     * Note: This will increaes the latency as it requires 2 additional synchronous API calls. Recommended to set TWILIO_AIA_IS_TYPING to "false" in .env file.
     */

    let finalAiAssistantIsTyping = context.TWILIO_AIA_IS_TYPING === "true";
    if (event.aiAssistantIsTyping) {
      finalAiAssistantIsTyping = true;
    }

    if (finalAiAssistantIsTyping) {
      console.log(
        `[conversations][messageAdded] Updating conversation attributes with isTyping... this increases latency`
      );
      // Get Conversation Attributes
      const conversationAttributes = await client.conversations.v1
        .services(event.ChatServiceSid)
        .conversations(event.ConversationSid)
        .fetch();

      const parsedConversationAttributes = JSON.parse(
        conversationAttributes.attributes
      );
      // Update Conversation Attributes
      await client.conversations.v1
        .services(event.ChatServiceSid)
        .conversations(event.ConversationSid)
        .update({
          attributes: JSON.stringify({
            ...parsedConversationAttributes,
            assistantIsTyping: true,
          }),
        });
    }
    /*
     * Step 4: Invoke Send Message to AI Assistant Function
     */
    console.log(
      `[conversations][messageAdded] AI Assistant SID: ${event.aiAssistantSid}`
    );
    console.log(`[conversations][messageAdded] End User Identity: ${identity}`);
    console.log(
      `[conversations][messageAdded] AI Assistant Identity: ${aiAssistantIdentity}`
    );
    console.log(
      `[conversations][messageAdded] Mode - isTyping: ${
        finalAiAssistantIsTyping ? "Enabled" : "Disabled"
      }`
    );
    console.log(`[conversations][messageAdded] Signed JWT`, signedJwt);
    const params = new URLSearchParams();
    params.append("_token", signedJwt);
    if (finalAiAssistantIsTyping) {
      params.append("aiAssistantIsTyping", "true");
    }
    const aiaSendMessagePayload = {
      body: event.Body,
      identity,
      session_id: `conversations__${event.ChatServiceSid}/${event.ConversationSid}`,
      webhook: `https://${
        context.DOMAIN_NAME
      }/conversations/response?${params.toString()}`,
    };

    const sendMessageResult = await sendMessageToAIA(
      context,
      event.aiAssistantSid,
      aiaSendMessagePayload
    );

    response.setBody({
      status: sendMessageResult,
    });

    /*
     * Last Step: Return API response
     */
    return callback(null, response);
  } catch (err) {
    console.log("[conversations][messageAdded] Catch Error", err);
    response.setBody({ error: "error" });
    response.setStatusCode(500);
    return callback(null, response);
  }
};
