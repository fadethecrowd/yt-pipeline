import { ActionType } from "@prisma/client";
import type { Decision, ActionResult } from "./lib/types";
import { heartComment, updateVideoTitle } from "./executor";
import { sendAlert } from "./telegram";

type ActionHandler = (decision: Decision) => Promise<ActionResult>;

const handlers: Record<ActionType, ActionHandler> = {
  [ActionType.HEART_COMMENT]: async (d) => {
    const commentId = d.payload.commentId as string;
    await heartComment(commentId);
    return { success: true, message: `Hearted comment ${commentId}` };
  },

  [ActionType.UPDATE_TITLE]: async (d) => {
    const newTitle = d.payload.newTitle as string | undefined;
    if (!newTitle) {
      return { success: false, message: "No newTitle in payload" };
    }
    await updateVideoTitle(d.videoId, newTitle);
    return { success: true, message: `Updated title to "${newTitle}"` };
  },

  [ActionType.ALERT]: async (d) => {
    await sendAlert(`🚀 ${d.reason} (video ${d.videoId})`);
    return { success: true, message: "Alert sent" };
  },

  // Stubs for actions not yet implemented
  [ActionType.PIN_COMMENT]: async () => ({ success: false, message: "Not implemented" }),
  [ActionType.REPLY_COMMENT]: async () => ({ success: false, message: "Not implemented" }),
  [ActionType.UPDATE_DESCRIPTION]: async () => ({ success: false, message: "Not implemented" }),
  [ActionType.UPDATE_TAGS]: async () => ({ success: false, message: "Not implemented" }),
};

/**
 * Route a decision to the appropriate handler and return the result.
 */
export async function routeAction(decision: Decision): Promise<ActionResult> {
  const handler = handlers[decision.type];
  try {
    return await handler(decision);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }
}
