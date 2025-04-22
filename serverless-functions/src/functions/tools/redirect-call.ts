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
  redirectNumber?: string;
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
  console.log("[redirect-call]] Event Received", event);
  const response = new Twilio.Response();

  // Set the CORS headers to allow Flex to make an error-free HTTP request
  // to this Function
  response.appendHeader("Access-Control-Allow-Origin", "*");
  response.appendHeader("Access-Control-Allow-Methods", "OPTIONS, GET, POST");
  response.appendHeader("Access-Control-Allow-Headers", "Content-Type");
  response.appendHeader("Content-Type", "application/json");

  // Check Required Parameters
  if (!event.redirectNumber || event.redirectNumber == "") {
    console.log("[redirect-call] Invalid redirectNumber");
    response.setStatusCode(400);
    response.setBody({ status: "Invalid redirectNumber" });
    return callback(null, response);
  }

  const client = context.getTwilioClient();
  const sessionId = event.request.headers["x-session-id"];

  /*
   * Step 2: Check Incoming Channel Type
   */
  if (sessionId.startsWith("voice")) {
    // Channel: Voice
    const [callSid] = sessionId.replace("voice:", "").split("/");
    let finalRedirectNumber: string = event.redirectNumber.trim();
    if (!finalRedirectNumber.startsWith("+")) {
      finalRedirectNumber = "+" + finalRedirectNumber;
    }
    const callUpdateResult = await client.calls(callSid).update({
      twiml: `
        <Response>
            <Dial>${finalRedirectNumber}</Dial>
        </Response>
      `,
    });
    response.setBody(callUpdateResult);
    return callback(null, response);
  } else {
    console.log(
      "[redirect-call] Invalid Channel - Redirect Call is only for Voice"
    );
    response.setStatusCode(400);
    response.setBody({
      status: "Invalid Channel - Redirect Call is only for Voice",
    });
    return callback(null, response);
  }
};
