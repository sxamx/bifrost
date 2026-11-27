import { createHmac, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { decryptSecret, encryptSecret } from './crypto.js';
import { redactSecretsInText } from './db.js';

export const DEFAULT_PLAYGROUND_CHAT_TITLE = 'Nuevo chat';
export const MAX_PLAYGROUND_TITLE_LENGTH = 160;
export const AUTO_PLAYGROUND_TITLE_MAX_LENGTH = 60;
export const MAX_PLAYGROUND_MESSAGE_CONTENT_LENGTH = 200_000;
export const MAX_PLAYGROUND_MESSAGE_REASONING_LENGTH = 200_000;
export const MAX_PLAYGROUND_SYSTEM_PROMPT_LENGTH = 100_000;
export const MAX_PLAYGROUND_METRIC_ERROR_LENGTH = 2_000;
export const MAX_PLAYGROUND_BATCH_MESSAGES = 50;
export const MAX_PLAYGROUND_MODEL_ID_LENGTH = 256;

export type PlaygroundMessageRole = 'user' | 'assistant' | 'system';
export type PlaygroundReasoningEffort = 'none' | 'low' | 'medium' | 'high';

const VALID_REASONING_EFFORTS = new Set<string>(['none', 'low', 'medium', 'high']);

export interface PlaygroundChatSettings {
  reasoningEffort?: PlaygroundReasoningEffort;
  temperature?: number | null;
  maxTokens?: number | null;
  systemPrompt?: string | null;
}

export interface PlaygroundMessageMetrics {
  ttftMs?: number | null;
  tokensPerSec?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  error?: string | null;
}

export interface PlaygroundChatSummary {
  id: string;
  title: string;
  modelFullId: string | null;
  settings: PlaygroundChatSettings | null;
  inProgress: boolean;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlaygroundChatMessage {
  id: string;
  chatId: string;
  role: PlaygroundMessageRole;
  content: string;
  reasoningContent: string | null;
  modelFullId: string | null;
  metrics: PlaygroundMessageMetrics | null;
  createdAt: number;
}

export interface PlaygroundChatDetail {
  chat: PlaygroundChatSummary;
  settings: PlaygroundChatSettings | null;
  inProgress: boolean;
  messages: PlaygroundChatMessage[];
}

export interface AppendPlaygroundMessageInput {
  role: PlaygroundMessageRole;
  content: string;
  reasoningContent?: string | null;
  modelFullId?: string | null;
  metrics?: PlaygroundMessageMetrics | null;
}

export interface AppendPlaygroundMessagesResult {
  chat: PlaygroundChatSummary;
  message: PlaygroundChatMessage;
  messages: PlaygroundChatMessage[];
}

export class PlaygroundHistoryError extends Error {
  public readonly status: 400 | 404;

  constructor(status: 400 | 404, message: string) {
    super(message);
    this.name = 'PlaygroundHistoryError';
    this.status = status;
  }
}

interface RawChatRow {
  id: string;
  user_id: string;
  encrypted_title: Uint8Array | Buffer;
  encrypted_settings: Uint8Array | Buffer | null;
  model_full_id: string | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  message_count?: number | bigint;
}

interface RawMessageRow {
  id: string;
  chat_id: string;
  user_id: string;
  role: string;
  encrypted_content: Uint8Array | Buffer;
  encrypted_reasoning: Uint8Array | Buffer | null;
  model_full_id: string | null;
  metrics_json: string | null;
  created_at: number | bigint;
}

const activeGeneratingChats = new Map<string, number>();

export function markChatGenerating(chatId: string, active: boolean): void {
  if (!chatId) return;
  if (active) {
    activeGeneratingChats.set(chatId, (activeGeneratingChats.get(chatId) ?? 0) + 1);
  } else {
    const current = activeGeneratingChats.get(chatId) ?? 0;
    if (current <= 1) {
      activeGeneratingChats.delete(chatId);
    } else {
      activeGeneratingChats.set(chatId, current - 1);
    }
  }
}

export function isChatGenerating(chatId: string): boolean {
  return (activeGeneratingChats.get(chatId) ?? 0) > 0;
}

export function resetGeneratingChatsForTests(): void {
  activeGeneratingChats.clear();
}

/**
 * Derives a unique 32-byte per-user AES-256-GCM subkey from the server masterKey.
 * Guarantees cryptographic separation between accounts at rest in SQLite.
 */
export function deriveUserPlaygroundKey(masterKey: Buffer, userId: string): Buffer {
  return createHmac('sha256', masterKey)
    .update(`bifrost-playground-chat:${userId}`)
    .digest();
}

export function assertPlaygroundChatOwned(
  db: DatabaseSync,
  userId: string,
  chatId: string,
): void {
  const row = db
    .prepare(`SELECT id FROM playground_chats WHERE id = ? AND user_id = ?`)
    .get(chatId, userId) as { id: string } | undefined;
  if (!row) {
    throw new PlaygroundHistoryError(404, 'Playground chat not found.');
  }
}

function validateModelFullId(raw: unknown): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new PlaygroundHistoryError(400, 'modelFullId must be a string or null.');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_PLAYGROUND_MODEL_ID_LENGTH) {
    throw new PlaygroundHistoryError(
      400,
      `modelFullId must not exceed ${MAX_PLAYGROUND_MODEL_ID_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function validateChatTitle(raw: unknown, allowEmptyDefault: boolean): string {
  if (raw === undefined || raw === null) {
    if (allowEmptyDefault) return DEFAULT_PLAYGROUND_CHAT_TITLE;
    throw new PlaygroundHistoryError(400, 'title must be a non-empty string.');
  }
  if (typeof raw !== 'string') {
    throw new PlaygroundHistoryError(400, 'title must be a string.');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    if (allowEmptyDefault) return DEFAULT_PLAYGROUND_CHAT_TITLE;
    throw new PlaygroundHistoryError(400, 'title must not be empty.');
  }
  if (trimmed.length > MAX_PLAYGROUND_TITLE_LENGTH) {
    throw new PlaygroundHistoryError(
      400,
      `title must not exceed ${MAX_PLAYGROUND_TITLE_LENGTH} characters.`,
    );
  }
  return trimmed;
}

function buildAutoTitleFromContent(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return DEFAULT_PLAYGROUND_CHAT_TITLE;
  }
  if (collapsed.length <= AUTO_PLAYGROUND_TITLE_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, AUTO_PLAYGROUND_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

export function sanitizePlaygroundChatSettings(raw: unknown): PlaygroundChatSettings | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlaygroundHistoryError(400, 'settings must be an object or null.');
  }
  const obj = raw as Record<string, unknown>;
  const out: PlaygroundChatSettings = {};
  let hasAny = false;

  if ('reasoningEffort' in obj && obj.reasoningEffort !== undefined) {
    if (
      typeof obj.reasoningEffort !== 'string' ||
      !VALID_REASONING_EFFORTS.has(obj.reasoningEffort.trim().toLowerCase())
    ) {
      throw new PlaygroundHistoryError(
        400,
        'settings.reasoningEffort must be one of "none", "low", "medium", or "high".',
      );
    }
    out.reasoningEffort = obj.reasoningEffort.trim().toLowerCase() as PlaygroundReasoningEffort;
    hasAny = true;
  }

  if ('temperature' in obj && obj.temperature !== undefined) {
    if (obj.temperature === null) {
      out.temperature = null;
      hasAny = true;
    } else if (
      typeof obj.temperature === 'number' &&
      Number.isFinite(obj.temperature) &&
      obj.temperature >= 0 &&
      obj.temperature <= 2
    ) {
      out.temperature = obj.temperature;
      hasAny = true;
    } else {
      throw new PlaygroundHistoryError(
        400,
        'settings.temperature must be a finite number between 0 and 2, or null.',
      );
    }
  }

  if ('maxTokens' in obj && obj.maxTokens !== undefined) {
    if (obj.maxTokens === null) {
      out.maxTokens = null;
      hasAny = true;
    } else if (
      typeof obj.maxTokens === 'number' &&
      Number.isInteger(obj.maxTokens) &&
      obj.maxTokens >= 1
    ) {
      out.maxTokens = obj.maxTokens;
      hasAny = true;
    } else {
      throw new PlaygroundHistoryError(
        400,
        'settings.maxTokens must be a positive integer or null.',
      );
    }
  }

  if ('systemPrompt' in obj && obj.systemPrompt !== undefined) {
    if (obj.systemPrompt === null) {
      out.systemPrompt = null;
      hasAny = true;
    } else if (typeof obj.systemPrompt === 'string') {
      if (obj.systemPrompt.length > MAX_PLAYGROUND_SYSTEM_PROMPT_LENGTH) {
        throw new PlaygroundHistoryError(
          400,
          `settings.systemPrompt must not exceed ${MAX_PLAYGROUND_SYSTEM_PROMPT_LENGTH} characters.`,
        );
      }
      out.systemPrompt = obj.systemPrompt.length > 0 ? obj.systemPrompt : null;
      hasAny = true;
    } else {
      throw new PlaygroundHistoryError(
        400,
        'settings.systemPrompt must be a string or null.',
      );
    }
  }

  return hasAny ? out : null;
}

function encryptChatSettings(
  settings: PlaygroundChatSettings | null,
  userKey: Buffer,
): Buffer | null {
  if (!settings) return null;
  return encryptSecret(JSON.stringify(settings), userKey);
}

function decryptChatSettings(
  blob: Uint8Array | Buffer | null | undefined,
  userKey: Buffer,
): PlaygroundChatSettings | null {
  if (blob === null || blob === undefined) return null;
  try {
    const rawText = decryptSecret(blob, userKey);
    const parsed = JSON.parse(rawText) as unknown;
    return sanitizePlaygroundChatSettings(parsed);
  } catch {
    return null;
  }
}

function sanitizeMetrics(raw: unknown): PlaygroundMessageMetrics | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlaygroundHistoryError(400, 'metrics must be an object or null.');
  }
  const obj = raw as Record<string, unknown>;
  const out: PlaygroundMessageMetrics = {};
  let hasAny = false;

  const numericKeys = [
    'ttftMs',
    'tokensPerSec',
    'promptTokens',
    'completionTokens',
    'reasoningTokens',
  ] as const;

  for (const key of numericKeys) {
    if (!(key in obj)) continue;
    const val = obj[key];
    if (val === null) {
      out[key] = null;
      hasAny = true;
    } else if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      out[key] = val;
      hasAny = true;
    } else if (val !== undefined) {
      throw new PlaygroundHistoryError(
        400,
        `metrics.${key} must be a non-negative finite number or null.`,
      );
    }
  }

  if ('error' in obj && obj.error !== undefined) {
    if (obj.error === null) {
      out.error = null;
      hasAny = true;
    } else if (typeof obj.error === 'string') {
      const safe = redactSecretsInText(obj.error).slice(0, MAX_PLAYGROUND_METRIC_ERROR_LENGTH);
      out.error = safe.length > 0 ? safe : null;
      hasAny = true;
    } else {
      throw new PlaygroundHistoryError(400, 'metrics.error must be a string or null.');
    }
  }

  return hasAny ? out : null;
}

function parseMetricsJson(rawJson: string | null): PlaygroundMessageMetrics | null {
  if (!rawJson) return null;
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const out: PlaygroundMessageMetrics = {};
    let hasAny = false;
    const keys = [
      'ttftMs',
      'tokensPerSec',
      'promptTokens',
      'completionTokens',
      'reasoningTokens',
    ] as const;
    for (const key of keys) {
      const val = obj[key];
      if (val === null) {
        out[key] = null;
        hasAny = true;
      } else if (typeof val === 'number' && Number.isFinite(val)) {
        out[key] = val;
        hasAny = true;
      }
    }
    if ('error' in obj) {
      if (obj.error === null) {
        out.error = null;
        hasAny = true;
      } else if (typeof obj.error === 'string' && obj.error.length > 0) {
        out.error = obj.error;
        hasAny = true;
      }
    }
    return hasAny ? out : null;
  } catch {
    return null;
  }
}

function validateSingleMessageInput(raw: unknown): {
  role: PlaygroundMessageRole;
  content: string;
  reasoningContent: string | null;
  modelFullId: string | null;
  metrics: PlaygroundMessageMetrics | null;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlaygroundHistoryError(400, 'Each message must be a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  const role = obj.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    throw new PlaygroundHistoryError(
      400,
      'Message role must be one of "user", "assistant", or "system".',
    );
  }

  if (typeof obj.content !== 'string') {
    throw new PlaygroundHistoryError(400, 'Message content must be a string.');
  }
  if (obj.content.length > MAX_PLAYGROUND_MESSAGE_CONTENT_LENGTH) {
    throw new PlaygroundHistoryError(
      400,
      `Message content exceeds maximum length of ${MAX_PLAYGROUND_MESSAGE_CONTENT_LENGTH} characters.`,
    );
  }

  let reasoningContent: string | null = null;
  if (obj.reasoningContent !== undefined && obj.reasoningContent !== null) {
    if (typeof obj.reasoningContent !== 'string') {
      throw new PlaygroundHistoryError(400, 'reasoningContent must be a string or null.');
    }
    if (obj.reasoningContent.length > MAX_PLAYGROUND_MESSAGE_REASONING_LENGTH) {
      throw new PlaygroundHistoryError(
        400,
        `reasoningContent exceeds maximum length of ${MAX_PLAYGROUND_MESSAGE_REASONING_LENGTH} characters.`,
      );
    }
    if (obj.reasoningContent.length > 0) {
      reasoningContent = obj.reasoningContent;
    }
  }

  const modelFullId = validateModelFullId(obj.modelFullId);
  const metrics = sanitizeMetrics(obj.metrics);

  if (obj.content.length === 0 && reasoningContent === null && !metrics?.error) {
    throw new PlaygroundHistoryError(400, 'Message content must not be empty.');
  }

  return {
    role,
    content: obj.content,
    reasoningContent,
    modelFullId,
    metrics,
  };
}

function mapChatRow(row: RawChatRow, userKey: Buffer): PlaygroundChatSummary {
  return {
    id: row.id,
    title: decryptSecret(row.encrypted_title, userKey),
    modelFullId: row.model_full_id ?? null,
    settings: decryptChatSettings(row.encrypted_settings, userKey),
    inProgress: isChatGenerating(row.id),
    messageCount: Number(row.message_count ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapMessageRow(row: RawMessageRow, userKey: Buffer): PlaygroundChatMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role as PlaygroundMessageRole,
    content: decryptSecret(row.encrypted_content, userKey),
    reasoningContent:
      row.encrypted_reasoning !== null && row.encrypted_reasoning !== undefined
        ? decryptSecret(row.encrypted_reasoning, userKey)
        : null,
    modelFullId: row.model_full_id ?? null,
    metrics: parseMetricsJson(row.metrics_json),
    createdAt: Number(row.created_at),
  };
}

export function listPlaygroundChats(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
): PlaygroundChatSummary[] {
  const userKey = deriveUserPlaygroundKey(masterKey, userId);
  const rows = db
    .prepare(
      `SELECT pc.id,
              pc.user_id,
              pc.encrypted_title,
              pc.encrypted_settings,
              pc.model_full_id,
              pc.created_at,
              pc.updated_at,
              (SELECT COUNT(*) FROM playground_messages pm
                WHERE pm.chat_id = pc.id AND pm.user_id = pc.user_id) AS message_count
       FROM playground_chats pc
       WHERE pc.user_id = ?
       ORDER BY pc.updated_at DESC, pc.rowid DESC`,
    )
    .all(userId) as unknown as RawChatRow[];

  return rows.map((row) => mapChatRow(row, userKey));
}

export function createPlaygroundChat(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
  rawBody: Record<string, unknown>,
  nowSec: number = Math.floor(Date.now() / 1000),
): PlaygroundChatSummary {
  const title = validateChatTitle(rawBody.title, true);
  const modelFullId = validateModelFullId(rawBody.modelFullId);
  const settings = sanitizePlaygroundChatSettings(rawBody.settings);
  const userKey = deriveUserPlaygroundKey(masterKey, userId);
  const encryptedTitle = encryptSecret(title, userKey);
  const encryptedSettings = encryptChatSettings(settings, userKey);
  const id = randomUUID();

  db.prepare(
    `INSERT INTO playground_chats (id, user_id, encrypted_title, encrypted_settings, model_full_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, encryptedTitle, encryptedSettings, modelFullId, nowSec, nowSec);

  return {
    id,
    title,
    modelFullId,
    settings,
    inProgress: isChatGenerating(id),
    messageCount: 0,
    createdAt: nowSec,
    updatedAt: nowSec,
  };
}

export function getPlaygroundChatDetail(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
  chatId: string,
): PlaygroundChatDetail {
  const userKey = deriveUserPlaygroundKey(masterKey, userId);
  const chatRow = db
    .prepare(
      `SELECT pc.id,
              pc.user_id,
              pc.encrypted_title,
              pc.encrypted_settings,
              pc.model_full_id,
              pc.created_at,
              pc.updated_at,
              (SELECT COUNT(*) FROM playground_messages pm
                WHERE pm.chat_id = pc.id AND pm.user_id = pc.user_id) AS message_count
       FROM playground_chats pc
       WHERE pc.id = ? AND pc.user_id = ?`,
    )
    .get(chatId, userId) as unknown as RawChatRow | undefined;

  if (!chatRow) {
    throw new PlaygroundHistoryError(404, 'Playground chat not found.');
  }

  const messageRows = db
    .prepare(
      `SELECT id, chat_id, user_id, role, encrypted_content, encrypted_reasoning,
              model_full_id, metrics_json, created_at
       FROM playground_messages
       WHERE chat_id = ? AND user_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(chatId, userId) as unknown as RawMessageRow[];

  const chat = mapChatRow(chatRow, userKey);
  return {
    chat,
    settings: chat.settings,
    inProgress: chat.inProgress,
    messages: messageRows.map((row) => mapMessageRow(row, userKey)),
  };
}

export function updatePlaygroundChat(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
  chatId: string,
  rawBody: Record<string, unknown>,
  nowSec: number = Math.floor(Date.now() / 1000),
): PlaygroundChatSummary {
  const hasTitle = 'title' in rawBody && rawBody.title !== undefined;
  const hasModel = 'modelFullId' in rawBody && rawBody.modelFullId !== undefined;
  const hasSettings = 'settings' in rawBody && rawBody.settings !== undefined;

  if (!hasTitle && !hasModel && !hasSettings) {
    throw new PlaygroundHistoryError(
      400,
      'At least one of "title", "modelFullId", or "settings" must be provided.',
    );
  }

  const existing = db
    .prepare(
      `SELECT pc.id,
              pc.user_id,
              pc.encrypted_title,
              pc.encrypted_settings,
              pc.model_full_id,
              pc.created_at,
              pc.updated_at,
              (SELECT COUNT(*) FROM playground_messages pm
                WHERE pm.chat_id = pc.id AND pm.user_id = pc.user_id) AS message_count
       FROM playground_chats pc
       WHERE pc.id = ? AND pc.user_id = ?`,
    )
    .get(chatId, userId) as unknown as RawChatRow | undefined;

  if (!existing) {
    throw new PlaygroundHistoryError(404, 'Playground chat not found.');
  }

  const userKey = deriveUserPlaygroundKey(masterKey, userId);
  const nextTitle = hasTitle
    ? validateChatTitle(rawBody.title, false)
    : decryptSecret(existing.encrypted_title, userKey);
  const nextEncryptedTitle = hasTitle
    ? encryptSecret(nextTitle, userKey)
    : existing.encrypted_title;
  const nextModelFullId = hasModel
    ? validateModelFullId(rawBody.modelFullId)
    : (existing.model_full_id ?? null);
  const nextSettings = hasSettings
    ? sanitizePlaygroundChatSettings(rawBody.settings)
    : decryptChatSettings(existing.encrypted_settings, userKey);
  const nextEncryptedSettings = hasSettings
    ? encryptChatSettings(nextSettings, userKey)
    : existing.encrypted_settings;

  db.prepare(
    `UPDATE playground_chats
     SET encrypted_title = ?, encrypted_settings = ?, model_full_id = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(nextEncryptedTitle, nextEncryptedSettings, nextModelFullId, nowSec, chatId, userId);

  return {
    id: existing.id,
    title: nextTitle,
    modelFullId: nextModelFullId,
    settings: nextSettings,
    inProgress: isChatGenerating(existing.id),
    messageCount: Number(existing.message_count ?? 0),
    createdAt: Number(existing.created_at),
    updatedAt: nowSec,
  };
}

export function appendPlaygroundMessages(
  db: DatabaseSync,
  masterKey: Buffer,
  userId: string,
  chatId: string,
  rawBody: Record<string, unknown>,
  nowSec: number = Math.floor(Date.now() / 1000),
): AppendPlaygroundMessagesResult {
  const existing = db
    .prepare(
      `SELECT pc.id,
              pc.user_id,
              pc.encrypted_title,
              pc.encrypted_settings,
              pc.model_full_id,
              pc.created_at,
              pc.updated_at,
              (SELECT COUNT(*) FROM playground_messages pm
                WHERE pm.chat_id = pc.id AND pm.user_id = pc.user_id) AS message_count
       FROM playground_chats pc
       WHERE pc.id = ? AND pc.user_id = ?`,
    )
    .get(chatId, userId) as unknown as RawChatRow | undefined;

  if (!existing) {
    throw new PlaygroundHistoryError(404, 'Playground chat not found.');
  }

  let rawList: unknown[];
  if ('messages' in rawBody && rawBody.messages !== undefined) {
    if (!Array.isArray(rawBody.messages)) {
      throw new PlaygroundHistoryError(400, '"messages" must be an array.');
    }
    rawList = rawBody.messages;
  } else {
    rawList = [rawBody];
  }

  if (rawList.length === 0) {
    throw new PlaygroundHistoryError(400, 'At least one message is required.');
  }
  if (rawList.length > MAX_PLAYGROUND_BATCH_MESSAGES) {
    throw new PlaygroundHistoryError(
      400,
      `Cannot append more than ${MAX_PLAYGROUND_BATCH_MESSAGES} messages at once.`,
    );
  }

  const validated = rawList.map((item) => validateSingleMessageInput(item));
  const userKey = deriveUserPlaygroundKey(masterKey, userId);

  let nextTitle = decryptSecret(existing.encrypted_title, userKey);
  let nextEncryptedTitle: Uint8Array | Buffer = existing.encrypted_title;
  if (nextTitle === DEFAULT_PLAYGROUND_CHAT_TITLE) {
    const firstUserMsg = validated.find(
      (m) => m.role === 'user' && m.content.trim().length > 0,
    );
    if (firstUserMsg) {
      nextTitle = buildAutoTitleFromContent(firstUserMsg.content);
      nextEncryptedTitle = encryptSecret(nextTitle, userKey);
    }
  }

  let nextModelFullId = existing.model_full_id ?? null;
  for (const m of validated) {
    if (m.modelFullId !== null) {
      nextModelFullId = m.modelFullId;
    }
  }

  const insertedMessages: PlaygroundChatMessage[] = [];
  const insertStmt = db.prepare(
    `INSERT INTO playground_messages (
       id, chat_id, user_id, role, encrypted_content, encrypted_reasoning,
       model_full_id, metrics_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const msg of validated) {
      const msgId = randomUUID();
      const encryptedContent = encryptSecret(msg.content, userKey);
      const encryptedReasoning =
        msg.reasoningContent !== null ? encryptSecret(msg.reasoningContent, userKey) : null;
      const metricsJson = msg.metrics !== null ? JSON.stringify(msg.metrics) : null;

      insertStmt.run(
        msgId,
        chatId,
        userId,
        msg.role,
        encryptedContent,
        encryptedReasoning,
        msg.modelFullId,
        metricsJson,
        nowSec,
      );

      insertedMessages.push({
        id: msgId,
        chatId,
        role: msg.role,
        content: msg.content,
        reasoningContent: msg.reasoningContent,
        modelFullId: msg.modelFullId,
        metrics: msg.metrics,
        createdAt: nowSec,
      });
    }

    db.prepare(
      `UPDATE playground_chats
       SET encrypted_title = ?, model_full_id = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ).run(nextEncryptedTitle, nextModelFullId, nowSec, chatId, userId);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const updatedChat: PlaygroundChatSummary = {
    id: existing.id,
    title: nextTitle,
    modelFullId: nextModelFullId,
    settings: decryptChatSettings(existing.encrypted_settings, userKey),
    inProgress: isChatGenerating(existing.id),
    messageCount: Number(existing.message_count ?? 0) + insertedMessages.length,
    createdAt: Number(existing.created_at),
    updatedAt: nowSec,
  };

  return {
    chat: updatedChat,
    message: insertedMessages[0]!,
    messages: insertedMessages,
  };
}

export function deletePlaygroundChat(
  db: DatabaseSync,
  userId: string,
  chatId: string,
): void {
  const result = db
    .prepare(`DELETE FROM playground_chats WHERE id = ? AND user_id = ?`)
    .run(chatId, userId);

  if (Number(result.changes) === 0) {
    throw new PlaygroundHistoryError(404, 'Playground chat not found.');
  }
  markChatGenerating(chatId, false);
}

export function clearPlaygroundChats(
  db: DatabaseSync,
  userId: string,
): { ok: true; deletedCount: number } {
  const ids = db
    .prepare(`SELECT id FROM playground_chats WHERE user_id = ?`)
    .all(userId) as Array<{ id: string }>;
  const result = db
    .prepare(`DELETE FROM playground_chats WHERE user_id = ?`)
    .run(userId);

  for (const row of ids) {
    markChatGenerating(row.id, false);
  }

  return {
    ok: true,
    deletedCount: Number(result.changes),
  };
}
