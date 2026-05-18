/**
 * Minimal Anthropic Messages API request types — only the fields pixelpipe
 * actually reads or rewrites. Anything else passes through untouched.
 *
 * Shape reference: https://docs.anthropic.com/en/api/messages
 */

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
  cache_control?: CacheControl;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
  cache_control?: CacheControl;
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface CacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description?: string;
  input_schema?: unknown;
  cache_control?: CacheControl;
}

export type SystemField = string | Array<TextBlock | ImageBlock>;

/** Anthropic's per-response token usage block. Same shape on streaming
 *  (inside the message_start event payload) and non-streaming responses. */
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface MessagesRequest {
  model: string;
  messages: Message[];
  system?: SystemField;
  tools?: ToolDef[];
  // … plus all the other fields we don't touch (max_tokens, temperature, …)
  [k: string]: unknown;
}
