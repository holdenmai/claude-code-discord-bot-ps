/**
 * Why a turn ran. `task-notification` means the CLI woke itself when a background
 * watcher fired — nobody prompted it, so nothing in the bot is waiting on it.
 */
export interface ResultOrigin {
  kind?: "task-notification" | string;
}

export type SDKMessage =
  | {
      type: "assistant";
      message: any;
      session_id: string;
    }
  | {
      type: "user";
      message: any;
      session_id: string;
    }
  | {
      type: "result";
      subtype: "success";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      session_id: string;
      total_cost_usd: number;
      /** What started this turn. Absent for a turn we prompted. */
      origin?: ResultOrigin;
    }
  | {
      type: "result";
      subtype: "error_max_turns" | "error_during_execution";
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      session_id: string;
      total_cost_usd: number;
      origin?: ResultOrigin;
    }
  | {
      type: "system";
      subtype: "init";
      apiKeySource: string;
      cwd: string;
      session_id: string;
      tools: string[];
      mcp_servers: {
        name: string;
        status: string;
      }[];
      model: string;
      permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan";
    }
  | {
      type: "rate_limit_event";
      rate_limit_info: {
        status: string;
        resetsAt: number; // unix seconds
        rateLimitType: string;
        overageStatus?: string;
        overageDisabledReason?: string;
        isUsingOverage?: boolean;
      };
      session_id: string;
    }
  | {
      // Background-task (Monitor/watcher) lifecycle events. The CLI only delivers
      // these while stdin is open — at EOF it tears every background task down
      // about 5 seconds after the turn's `result`.
      type: "system";
      subtype: "task_started" | "task_notification" | "task_updated";
      session_id: string;
      task_id?: string;
      tool_use_id?: string;
      task_type?: string;
      description?: string;
      status?: string;
      output_file?: string;
      summary?: string;
      /** Unique per notification. A watcher can fire repeatedly under one task id. */
      uuid?: string;
      patch?: { status?: string; end_time?: number };
    }
  | {
      // The full list of live background tasks, re-sent whenever it changes. Being
      // a snapshot rather than a delta makes it the authority on what's running.
      type: "system";
      subtype: "background_tasks_changed";
      session_id: string;
      tasks: { task_id: string; task_type?: string; description?: string }[];
    };

export interface ChannelProcess {
  process: any;
  sessionId?: string;
  discordMessage: any;
}

export interface Config {
  discordToken: string;
  allowedUserId: string;
  baseFolder: string;
}

export type CompletionStatus = "success" | "partial" | "failed";

export interface ReactionConfig {
  enabled: boolean;
  processing: string;
  success: string;
  partial: string;
  failed: string;
}

export type ActivityPostStyle = "plaintext" | "embed" | "link";

export interface ActivityLinkConfig {
  enabled: boolean;
  style: ActivityPostStyle;
}

export type PromptLinkStyle = "none" | "link" | "plaintext" | "embed";

export interface PromptLinkConfig {
  enabled: boolean;
  style: PromptLinkStyle;
}

export function getPromptLinkConfig(): PromptLinkConfig {
  const style = (process.env.PROMPT_LINK_STYLE as PromptLinkStyle) || "link";
  return {
    enabled: style !== "none",
    style,
  };
}

export function getActivityLinkConfig(): ActivityLinkConfig {
  return {
    enabled: process.env.ACTIVITY_LINKS === "true",
    style: (process.env.ACTIVITY_LINK_STYLE as ActivityPostStyle) || "plaintext",
  };
}

export function getReactionConfig(): ReactionConfig {
  return {
    enabled: process.env.ENABLE_REACTIONS === "true",
    processing: process.env.REACTION_PROCESSING || "🤝",
    success: process.env.REACTION_SUCCESS || "👍",
    partial: process.env.REACTION_PARTIAL || "🤞",
    failed: process.env.REACTION_FAILED || "👎",
  };
}